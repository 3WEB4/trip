import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { applyProgress, JobStore, QueueFullError, type Job } from '../src/jobs/jobStore.js';
import type { CompareOutcome } from '../src/compare/compareMarkets.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tokyo-2848471');
const DETAIL_URL =
  'https://www.trip.com/hotels/detail/?hotelId=2848471&checkIn=2026-09-15&checkOut=2026-09-16&adult=2&crn=1';

/** Server pinned to saved responses, i.e. the demo mode the UI can run on. */
const app = buildServer({ fixturesDir: FIXTURES });
afterAll(() => app.close());

async function waitForJob(id: string, timeoutMs = 10_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/api/jobs/${id}` });
    const job = response.json() as Job;
    if (job.state === 'succeeded' || job.state === 'failed') return job;
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('job routes', () => {
  it('queues a comparison and reports the finished result', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { tripUrl: DETAIL_URL, markets: ['JP', 'NL'], targetCurrency: 'JPY' },
    });

    expect(created.statusCode).toBe(202);
    const job = created.json() as Job;
    // A short job can already be running by the time the 202 is serialized.
    expect(['queued', 'running']).toContain(job.state);
    expect(job.progress.markets.map((entry) => entry.market)).toEqual(['JP', 'NL']);

    const finished = await waitForJob(job.id);
    expect(finished.state).toBe('succeeded');
    expect(finished.progress.percent).toBe(100);
    expect(finished.progress.markets.every((entry) => entry.state === 'done')).toBe(true);
    expect(finished.result?.cheapestMarket).toBe('NL');
  });

  it('gives every market a bookable deep link carrying the compared room', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { tripUrl: DETAIL_URL, markets: ['JP', 'NL'] },
    });
    const finished = await waitForJob((created.json() as Job).id);
    const result = finished.result as CompareOutcome;

    const nl = result.prices.find((price) => price.market === 'NL')!;
    const url = new URL(nl.bookingUrl);
    expect(url.origin).toBe('https://nl.trip.com');
    expect(url.searchParams.get('hotelId')).toBe('2848471');
    expect(url.searchParams.get('roomId')).toBe(String(nl.roomId));
    expect(url.searchParams.get('checkIn')).toBe('2026-09-15');
    expect(url.searchParams.get('locale')).toBe('nl-NL');
    expect(url.searchParams.get('curr')).toBe('JPY');
  });

  it('rejects a bad URL before queueing any work', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { tripUrl: 'https://www.booking.com/hotel/jp/x.html' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_trip_url');
  });

  it('rejects an unknown market', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: { tripUrl: DETAIL_URL, markets: ['ZZ'] } });
    expect(response.statusCode).toBe(400);
  });

  it('404s an unknown job id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/jobs/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it('ignores a client-supplied fixture directory when the server pins one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/hotel-price-comparisons',
      payload: { tripUrl: DETAIL_URL, markets: ['JP', 'NL'], fixturesDir: '/etc' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('advertises demo mode so the UI can label the prices', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/markets' });
    expect(response.json().demoMode).toBe(true);
  });

  it('serves the comparison screen', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Trip.com');
  });
});

describe('JobStore', () => {
  const outcome = { prices: [] } as unknown as CompareOutcome;

  it('runs one job at a time and keeps the queue ordered', async () => {
    const started: string[] = [];
    let release: (() => void) | null = null;

    const store = new JobStore(async (job) => {
      started.push(job.request.tripUrl);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return outcome;
    });

    const first = store.create({ tripUrl: 'a', markets: ['JP'], targetCurrency: 'JPY', samples: 1 });
    const second = store.create({ tripUrl: 'b', markets: ['JP'], targetCurrency: 'JPY', samples: 1 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['a']);
    expect(store.get(second.id)?.state).toBe('queued');

    release!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toEqual(['a', 'b']);
    expect(store.get(first.id)?.state).toBe('succeeded');

    release!();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('records a runner failure on the job instead of throwing', async () => {
    const store = new JobStore(async () => {
      throw new Error('chrome unreachable');
    });
    const job = store.create({ tripUrl: 'a', markets: ['JP'], targetCurrency: 'JPY', samples: 1 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const finished = store.get(job.id)!;
    expect(finished.state).toBe('failed');
    expect(finished.error?.message).toBe('chrome unreachable');
  });

  it('refuses work once the queue is full', async () => {
    const store = new JobStore(async () => new Promise(() => outcome), { maxQueued: 2 });
    const request = { tripUrl: 'a', markets: ['JP'], targetCurrency: 'JPY', samples: 1 };
    store.create(request);
    store.create(request);
    store.create(request);
    expect(() => store.create(request)).toThrow(QueueFullError);
  });
});

describe('applyProgress', () => {
  function blankJob(markets: string[]): Job {
    return {
      id: 'x',
      state: 'running',
      createdAt: '',
      startedAt: null,
      finishedAt: null,
      queuePosition: 0,
      request: { tripUrl: '', markets, targetCurrency: 'JPY', samples: 1 },
      progress: { markets: markets.map((market) => ({ market, state: 'pending', note: null })), phase: 'fetching', percent: 0 },
      result: null,
      error: null,
    };
  }

  it('tracks per-market state and moves the bar', () => {
    const job = blankJob(['JP', 'NL']);

    applyProgress(job, { type: 'market-start', market: 'JP', sample: 1, totalSamples: 1 });
    expect(job.progress.markets[0]!.state).toBe('running');

    applyProgress(job, { type: 'market-done', market: 'JP', offers: 3 });
    expect(job.progress.markets[0]!.state).toBe('done');
    expect(job.progress.percent).toBe(45);

    applyProgress(job, { type: 'market-failed', market: 'NL', reason: 'http-430', manualActionRequired: true });
    expect(job.progress.markets[1]!.state).toBe('failed');
    expect(job.progress.markets[1]!.note).toContain('手動対応');

    applyProgress(job, { type: 'matching' });
    expect(job.progress.phase).toBe('matching');
    expect(job.progress.percent).toBeGreaterThanOrEqual(92);
  });
});

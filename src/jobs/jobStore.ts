/**
 * MVP step 9: comparison jobs with progress.
 *
 * A comparison takes tens of seconds per market, which is far too long to hold
 * an HTTP request open, so the API hands back a job id and the UI polls it.
 *
 * The queue is in-process and the browser is driven one job at a time on
 * purpose: the attached Chrome is a single shared resource, and running market
 * pages in parallel from one IP is exactly what gets an address blocked. The
 * `JobStore` surface is deliberately small (`create` / `get` / `list`) so the
 * design's BullMQ + Redis queue can replace it without touching the routes.
 */

import { randomUUID } from 'node:crypto';
import type { CompareOutcome, ProgressEvent } from '../compare/compareMarkets.js';
import type { MarketCode } from '../types.js';
import { logger } from '../util/logger.js';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';
export type MarketState = 'pending' | 'running' | 'done' | 'failed';

export interface JobProgress {
  /** Per-market state, in the order the markets were requested. */
  markets: Array<{ market: MarketCode; state: MarketState; note: string | null }>;
  /** Current phase, for the status line. */
  phase: 'queued' | 'fetching' | 'matching' | 'converting' | 'finished';
  /** 0-100, for the progress bar. */
  percent: number;
}

export interface Job {
  id: string;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Position in the queue while waiting; 0 once running. */
  queuePosition: number;
  request: { tripUrl: string; markets: MarketCode[]; targetCurrency: string; samples: number };
  progress: JobProgress;
  result: CompareOutcome | null;
  error: { code: string; message: string } | null;
}

/** Public view of a job — the request URL is echoed back, nothing else leaks. */
export type JobView = Omit<Job, 'request'> & { request: Job['request'] };

export interface JobRunner {
  (job: Job, onProgress: (event: ProgressEvent) => void): Promise<CompareOutcome>;
}

export interface JobStoreOptions {
  /** How long a finished job stays readable, in ms. */
  ttlMs?: number;
  /** Refuse new work beyond this many waiting jobs. */
  maxQueued?: number;
}

export class QueueFullError extends Error {
  constructor(limit: number) {
    super(`Too many comparisons are already queued (limit ${limit}). Try again shortly.`);
    this.name = 'QueueFullError';
  }
}

function initialProgress(markets: MarketCode[]): JobProgress {
  return {
    markets: markets.map((market) => ({ market, state: 'pending', note: null })),
    phase: 'queued',
    percent: 0,
  };
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: string[] = [];
  private running = false;
  private readonly ttlMs: number;
  private readonly maxQueued: number;

  constructor(
    private readonly runner: JobRunner,
    options: JobStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxQueued = options.maxQueued ?? 20;
  }

  create(request: Job['request']): Job {
    this.evictExpired();
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError(this.maxQueued);

    const job: Job = {
      id: randomUUID(),
      state: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      queuePosition: this.waiting.length + (this.running ? 1 : 0),
      request,
      progress: initialProgress(request.markets),
      result: null,
      error: null,
    };

    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    void this.drain();
    return job;
  }

  get(id: string): Job | null {
    this.evictExpired();
    return this.jobs.get(id) ?? null;
  }

  /** Newest first. */
  list(limit = 20): Job[] {
    this.evictExpired();
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) this.jobs.delete(id);
    }
  }

  private renumberQueue(): void {
    this.waiting.forEach((id, index) => {
      const job = this.jobs.get(id);
      if (job) job.queuePosition = index + 1;
    });
  }

  /** Runs queued jobs one at a time until the queue empties. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      for (;;) {
        const id = this.waiting.shift();
        if (id === undefined) break;
        this.renumberQueue();

        const job = this.jobs.get(id);
        if (!job) continue;

        job.state = 'running';
        job.queuePosition = 0;
        job.startedAt = new Date().toISOString();
        job.progress.phase = 'fetching';

        try {
          job.result = await this.runner(job, (event) => applyProgress(job, event));
          job.state = 'succeeded';
          job.progress.phase = 'finished';
          job.progress.percent = 100;
        } catch (error) {
          job.state = 'failed';
          job.progress.phase = 'finished';
          job.error = {
            code: (error as { code?: string }).code ?? (error as Error).name ?? 'error',
            message: (error as Error).message,
          };
          logger.warn('job failed', { jobId: job.id, message: job.error.message });
        } finally {
          job.finishedAt = new Date().toISOString();
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Translates a comparison event into the job's progress snapshot. */
export function applyProgress(job: Job, event: ProgressEvent): void {
  const entry = 'market' in event ? job.progress.markets.find((item) => item.market === event.market) : undefined;

  switch (event.type) {
    case 'market-start':
      if (entry) {
        entry.state = 'running';
        entry.note = event.totalSamples > 1 ? `${event.sample}/${event.totalSamples} 回目` : null;
      }
      break;
    case 'market-done':
      if (entry) {
        entry.state = 'done';
        entry.note = `${event.offers}件の客室`;
      }
      break;
    case 'market-failed':
      if (entry) {
        entry.state = 'failed';
        entry.note = event.manualActionRequired ? `${event.reason}（手動対応が必要）` : event.reason;
      }
      break;
    case 'matching':
      job.progress.phase = 'matching';
      break;
    case 'converting':
      job.progress.phase = 'converting';
      break;
  }

  // Fetching is the slow part, so it owns 90% of the bar.
  const total = job.progress.markets.length || 1;
  const settled = job.progress.markets.filter((item) => item.state === 'done' || item.state === 'failed').length;
  const fetchPercent = Math.round((settled / total) * 90);
  job.progress.percent =
    job.progress.phase === 'matching' ? Math.max(fetchPercent, 92) : job.progress.phase === 'converting' ? 96 : fetchPercent;
}

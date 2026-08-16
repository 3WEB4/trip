import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tokyo-2848471');
const DETAIL_URL =
  'https://www.trip.com/hotels/detail/?hotelId=2848471&checkIn=2026-09-15&checkOut=2026-09-16&adult=2&crn=1';

// Client-chosen fixture directories are off by default; the tests opt in.
const app = buildServer({ allowClientFixtures: true });
afterAll(() => app.close());

describe('POST /api/hotel-price-comparisons', () => {
  it('returns the ranked comparison', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/hotel-price-comparisons',
      payload: { tripUrl: DETAIL_URL, markets: ['JP', 'NL'], targetCurrency: 'JPY', fixturesDir: FIXTURES },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.hotel.hotelId).toBe(2848471);
    expect(body.prices).toHaveLength(2);
    expect(body.cheapestMarket).toBe('NL');
    expect(body.targetCurrency).toBe('JPY');
  });

  it('rejects a malformed body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/hotel-price-comparisons', payload: { markets: [] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('rejects a non-Trip.com URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/hotel-price-comparisons',
      payload: { tripUrl: 'https://www.booking.com/hotel/jp/x.html', fixturesDir: FIXTURES },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_trip_url');
  });

  it('rejects an unknown market', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/hotel-price-comparisons',
      payload: { tripUrl: DETAIL_URL, markets: ['JP', 'ZZ'], fixturesDir: FIXTURES },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'unknown_market', markets: ['ZZ'] });
  });

  it('answers 502 when no market produced a comparable offer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/hotel-price-comparisons',
      payload: { tripUrl: DETAIL_URL, markets: ['FR'], fixturesDir: FIXTURES },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('no_comparable_offer');
  });
});

describe('supporting routes', () => {
  it('lists the known markets', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/markets' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.defaults).toEqual(['JP', 'NL']);
    expect(body.markets.find((market: { code: string }) => market.code === 'NL')).toMatchObject({
      origin: 'https://nl.trip.com',
      locale: 'nl-NL',
    });
  });

  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

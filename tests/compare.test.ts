import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixtureMarketFetcher } from '../src/browser/fixtureFetcher.js';
import { MarketFetchError, type MarketFetcher } from '../src/browser/fetcher.js';
import { compareMarkets } from '../src/compare/compareMarkets.js';
import { StaticRateProvider } from '../src/fx/rates.js';
import { runComparison } from '../src/pipeline.js';
import type { MarketConfig, MarketSample, SearchCriteria } from '../src/types.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tokyo-2848471');
const DETAIL_URL =
  'https://www.trip.com/hotels/detail/?hotelId=2848471&checkIn=2026-09-15&checkOut=2026-09-16&adult=2&children=0&crn=1';

const criteria: SearchCriteria = {
  hotelId: 2848471,
  checkIn: '2026-09-15',
  checkOut: '2026-09-16',
  adult: 2,
  children: 0,
  childAges: [],
  roomQuantity: 1,
  currency: 'JPY',
};

describe('compareMarkets over saved responses', () => {
  it('produces the JP/NL comparison the MVP is scoped to', async () => {
    const result = await compareMarkets(criteria, new FixtureMarketFetcher(FIXTURES), {
      markets: ['JP', 'NL'],
      targetCurrency: 'JPY',
      rateProvider: new StaticRateProvider(),
      delayMs: 0,
    });

    expect(result.prices.map((price) => price.market)).toEqual(['NL', 'JP']);
    expect(result.cheapestMarket).toBe('NL');
    // Cheapest plan both markets sell: JPY 41,800 in JP vs 41,250 in NL.
    expect(result.savingVsJapan).toBe(550);
    expect(result.matchedOn).toMatchObject({ roomCode: 'K91LMP-Z-1', cancellation: 'non-refundable' });
    expect(result.failures).toEqual([]);
    expect(result.unmatchedMarkets).toEqual([]);
    expect(result.matchQuality?.confidence).toBe('exact');
  });

  it('reproduces the verified figures when the URL preselects a room', async () => {
    const result = await compareMarkets({ ...criteria, roomId: 1599611286 }, new FixtureMarketFetcher(FIXTURES), {
      markets: ['JP', 'NL'],
      targetCurrency: 'JPY',
      rateProvider: new StaticRateProvider(),
      delayMs: 0,
    });

    expect(result.matchedOn?.roomCode).toBe('Q72FXT-Z-1');
    expect(result.prices).toEqual([
      expect.objectContaining({ market: 'JP', convertedPrice: 44269, jpyPrice: 44269, roomId: 1599611286 }),
      expect.objectContaining({ market: 'NL', convertedPrice: 44750, jpyPrice: 44750, roomId: 1599611286 }),
    ]);
    expect(result.cheapestMarket).toBe('JP');
    expect(result.savingVsJapan).toBe(0);
  });

  it('records a blocked market as a failure instead of failing the run', async () => {
    const blocking: MarketFetcher & { meta: { hotelName: string | null } } = {
      name: 'test',
      meta: { hotelName: null },
      async fetch(market: MarketConfig, search: SearchCriteria): Promise<MarketSample> {
        if (market.code === 'NL') {
          throw new MarketFetchError('NL', 'http-430', 'blocked', true);
        }
        return new FixtureMarketFetcher(FIXTURES).fetch(market, search);
      },
      async close(): Promise<void> {},
    };

    const result = await compareMarkets(criteria, blocking, {
      markets: ['JP', 'NL'],
      rateProvider: new StaticRateProvider(),
      delayMs: 0,
    });

    expect(result.failures).toEqual([
      { market: 'NL', reason: 'http-430', message: 'blocked', manualActionRequired: true },
    ]);
    expect(result.prices.map((price) => price.market)).toEqual(['JP']);
    expect(result.cheapestMarket).toBe('JP');
    expect(result.savingVsJapan).toBe(0);
  });

  it('reports the median across samples and keeps every capture time', async () => {
    let round = 0;
    const prices = [44269, 45000, 44500];
    const varying: MarketFetcher & { meta: { hotelName: string | null } } = {
      name: 'test',
      meta: { hotelName: null },
      async fetch(market: MarketConfig): Promise<MarketSample> {
        const totalPrice = market.code === 'JP' ? prices[round++ % prices.length]! : 44750;
        return {
          market: market.code,
          capturedAt: new Date(Date.UTC(2026, 7, 16, round)).toISOString(),
          offers: [
            {
              hotelId: 2848471,
              physicalRoomId: 430120748,
              roomId: 1599611286,
              roomCode: 'Q72FXT-Z-1',
              roomName: 'Deluxe Twin',
              availability: true,
              remainRoomQuantity: 3,
              currency: 'JPY',
              price: null,
              tax: null,
              totalPrice,
              originalPrice: null,
              meal: 'room-only',
              mealRaw: null,
              cancellation: 'free',
              cancellationRaw: null,
              payment: 'prepay',
              taxIncluded: true,
            },
          ],
        };
      },
      async close(): Promise<void> {},
    };

    const result = await compareMarkets(criteria, varying, {
      markets: ['JP', 'NL'],
      samples: 3,
      delayMs: 0,
      rateProvider: new StaticRateProvider(),
    });

    const jp = result.prices.find((price) => price.market === 'JP')!;
    expect(jp.originalPrice).toBe(44500);
    expect(jp.sampleCount).toBe(3);
    expect(jp.capturedAt).toHaveLength(3);
  });

  it('converts a market that quoted its own currency', async () => {
    const mixed: MarketFetcher & { meta: { hotelName: string | null } } = {
      name: 'test',
      meta: { hotelName: null },
      async fetch(market: MarketConfig): Promise<MarketSample> {
        const inEuro = market.code === 'NL';
        return {
          market: market.code,
          capturedAt: '2026-08-16T00:00:00.000Z',
          offers: [
            {
              hotelId: 2848471,
              physicalRoomId: 430120748,
              roomId: 1599611286,
              roomCode: 'Q72FXT-Z-1',
              roomName: 'Deluxe Twin',
              availability: true,
              remainRoomQuantity: 3,
              currency: inEuro ? 'EUR' : 'JPY',
              price: null,
              tax: null,
              totalPrice: inEuro ? 250 : 44269,
              originalPrice: null,
              meal: 'room-only',
              mealRaw: null,
              cancellation: 'free',
              cancellationRaw: null,
              payment: 'prepay',
              taxIncluded: true,
            },
          ],
        };
      },
      async close(): Promise<void> {},
    };

    const result = await compareMarkets(criteria, mixed, {
      markets: ['JP', 'NL'],
      targetCurrency: 'JPY',
      delayMs: 0,
      rateProvider: new StaticRateProvider({ 'EUR:JPY': 170 }),
    });

    const nl = result.prices.find((price) => price.market === 'NL')!;
    expect(nl.currency).toBe('EUR');
    expect(nl.originalPrice).toBe(250);
    expect(nl.convertedPrice).toBe(42500);
    expect(result.cheapestMarket).toBe('NL');
    expect(result.savingVsJapan).toBe(1769);
  });
});

describe('runComparison', () => {
  it('goes from a pasted URL to a ranked result', async () => {
    const result = await runComparison(DETAIL_URL, {
      markets: ['JP', 'NL'],
      fixturesDir: FIXTURES,
      rateProvider: new StaticRateProvider(),
      delayMs: 0,
    });

    expect(result.hotel).toMatchObject({ hotelId: 2848471, name: 'Example Hotel Tokyo', checkIn: '2026-09-15' });
    expect(result.targetCurrency).toBe('JPY');
    expect(result.prices).toHaveLength(2);
    expect(result.cheapestMarket).toBe('NL');
  });
});

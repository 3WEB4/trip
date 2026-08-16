/**
 * Ties the MVP together: URL → criteria → per-market capture → comparison.
 */

import { CdpMarketFetcher, type CdpFetcherOptions } from './browser/cdpFetcher.js';
import type { MarketFetcher } from './browser/fetcher.js';
import { FixtureMarketFetcher } from './browser/fixtureFetcher.js';
import { compareMarkets, type CompareOutcome } from './compare/compareMarkets.js';
import { FrankfurterRateProvider, StaticRateProvider, type RateProvider } from './fx/rates.js';
import { DEFAULT_MARKETS, getMarket } from './markets/markets.js';
import { parseTripUrl } from './url/parseTripUrl.js';
import type { MarketCode, SearchCriteria } from './types.js';

export interface RunOptions {
  markets?: MarketCode[];
  targetCurrency?: string;
  samples?: number;
  delayMs?: number;
  baselineMarket?: MarketCode;
  /** Replay saved responses instead of driving Chrome. */
  fixturesDir?: string;
  cdp?: CdpFetcherOptions;
  /** Defaults to live ECB rates, falling back to static ones. */
  rateProvider?: RateProvider;
  /** Overrides parsed criteria — used when the caller already has them. */
  criteria?: SearchCriteria;
}

function buildFetcher(options: RunOptions): MarketFetcher & { meta: { hotelName: string | null } } {
  if (options.fixturesDir) return new FixtureMarketFetcher(options.fixturesDir);
  return new CdpMarketFetcher(options.cdp ?? {});
}

export async function runComparison(tripUrl: string, options: RunOptions = {}): Promise<CompareOutcome> {
  const targetCurrency = (options.targetCurrency ?? 'JPY').toUpperCase();
  const criteria = options.criteria ?? parseTripUrl(tripUrl, { targetCurrency });
  const markets = (options.markets ?? DEFAULT_MARKETS).map((code) => getMarket(code).code);

  const fetcher = buildFetcher(options);
  try {
    const result = await compareMarkets(criteria, fetcher, {
      markets,
      targetCurrency,
      samples: options.samples ?? 1,
      delayMs: options.delayMs ?? 1_500,
      rateProvider: options.rateProvider ?? new FrankfurterRateProvider(new StaticRateProvider()),
      baselineMarket: options.baselineMarket ?? 'JP',
    });
    if (result.hotel.name === null) result.hotel.name = fetcher.meta.hotelName;
    return result;
  } finally {
    await fetcher.close();
  }
}

export { parseTripUrl, compareMarkets, DEFAULT_MARKETS };

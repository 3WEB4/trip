/**
 * MVP step 6: run every market, line the offers up, convert and rank.
 */

import type { MarketFetcher } from '../browser/fetcher.js';
import { MarketFetchError } from '../browser/fetcher.js';
import { convert, roundForCurrency, StaticRateProvider, type RateProvider } from '../fx/rates.js';
import { buildHotelDetailUrl, getMarket } from '../markets/markets.js';
import { compareOffers, matchAcrossMarkets, type OfferMatch } from '../match/matchOffers.js';
import type {
  ComparisonResult,
  MarketCode,
  MarketFailure,
  MarketPrice,
  MarketSample,
  RoomOffer,
  SearchCriteria,
} from '../types.js';
import { logger } from '../util/logger.js';
import { median } from '../util/stats.js';

/**
 * Emitted while a comparison runs, so a UI can show which market is being
 * scraped instead of a spinner with no information.
 */
export type ProgressEvent =
  | { type: 'market-start'; market: MarketCode; sample: number; totalSamples: number }
  | { type: 'market-done'; market: MarketCode; offers: number }
  | { type: 'market-failed'; market: MarketCode; reason: string; manualActionRequired: boolean }
  | { type: 'matching' }
  | { type: 'converting' };

export interface CompareOptions {
  markets: MarketCode[];
  targetCurrency?: string;
  /** How many times to sample each market; the median is reported. */
  samples?: number;
  /** Pause between requests to the same market, in ms. */
  delayMs?: number;
  rateProvider?: RateProvider;
  /** Market the savings are measured against. */
  baselineMarket?: MarketCode;
  /** Market whose offers seed matching. Defaults to the baseline. */
  anchorMarket?: MarketCode;
  /** Hotel name, when the caller already knows it. */
  hotelName?: string | null;
  /** Progress callback. Errors thrown by it are ignored. */
  onProgress?: (event: ProgressEvent) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Finds this round's offer for an already-matched product. */
function offerMatching(sample: MarketSample, reference: RoomOffer): RoomOffer | null {
  let best: { offer: RoomOffer; score: number } | null = null;
  for (const offer of sample.offers) {
    const result = compareOffers(reference, offer);
    if (result.ok && (!best || result.strictScore > best.score)) {
      best = { offer, score: result.strictScore };
    }
  }
  return best?.offer ?? null;
}

async function buildMarketPrice(
  market: MarketCode,
  matchedOffer: RoomOffer,
  rounds: MarketSample[],
  criteria: SearchCriteria,
  targetCurrency: string,
  rateProvider: RateProvider,
): Promise<MarketPrice | null> {
  const prices: number[] = [];
  const capturedAt: string[] = [];

  for (const round of rounds) {
    const offer = offerMatching(round, matchedOffer);
    if (!offer?.totalPrice) continue;
    prices.push(offer.totalPrice);
    capturedAt.push(round.capturedAt);
  }
  if (prices.length === 0) return null;

  const originalPrice = roundForCurrency(median(prices), matchedOffer.currency);
  const convertedPrice = await convert(originalPrice, matchedOffer.currency, targetCurrency, rateProvider);

  return {
    market,
    physicalRoomId: matchedOffer.physicalRoomId,
    roomId: matchedOffer.roomId,
    roomCode: matchedOffer.roomCode,
    roomName: matchedOffer.roomName,
    currency: matchedOffer.currency,
    originalPrice,
    convertedPrice,
    targetCurrency,
    // `jpyPrice` is kept as the documented API field name; it always holds the
    // price in `targetCurrency`, which defaults to JPY.
    jpyPrice: convertedPrice,
    availability: matchedOffer.availability,
    meal: matchedOffer.meal,
    cancellation: matchedOffer.cancellation,
    payment: matchedOffer.payment,
    taxIncluded: matchedOffer.taxIncluded,
    sampleCount: prices.length,
    capturedAt,
    bookingUrl: buildHotelDetailUrl(
      getMarket(market),
      { ...criteria, currency: targetCurrency },
      matchedOffer.roomId,
    ),
  };
}

export interface CompareOutcome extends ComparisonResult {
  /** Matching diagnostics — how sure we are the products line up. */
  matchQuality: { confidence: OfferMatch['confidence']; warnings: string[] } | null;
}

export async function compareMarkets(
  criteria: SearchCriteria,
  fetcher: MarketFetcher,
  options: CompareOptions,
): Promise<CompareOutcome> {
  const targetCurrency = (options.targetCurrency ?? criteria.currency ?? 'JPY').toUpperCase();
  const sampleCount = Math.max(1, options.samples ?? 1);
  const delayMs = options.delayMs ?? 1_500;
  const rateProvider = options.rateProvider ?? new StaticRateProvider();
  const baseline = (options.baselineMarket ?? 'JP').toUpperCase();

  const roundsByMarket = new Map<MarketCode, MarketSample[]>();
  const failures: MarketFailure[] = [];

  // Progress is advisory only; a broken listener must not fail a comparison.
  const report = (event: ProgressEvent): void => {
    try {
      options.onProgress?.(event);
    } catch {
      // ignored on purpose
    }
  };

  for (const code of options.markets) {
    const market = getMarket(code);
    const rounds: MarketSample[] = [];
    let lastFailure: MarketFailure | null = null;

    for (let round = 0; round < sampleCount; round += 1) {
      report({ type: 'market-start', market: market.code, sample: round + 1, totalSamples: sampleCount });
      try {
        const sample = await fetcher.fetch(market, { ...criteria, currency: targetCurrency });
        rounds.push(sample);
        report({ type: 'market-done', market: market.code, offers: sample.offers.length });
      } catch (error) {
        lastFailure =
          error instanceof MarketFetchError
            ? {
                market: market.code,
                reason: error.reason,
                message: error.message,
                manualActionRequired: error.manualActionRequired,
              }
            : {
                market: market.code,
                reason: 'unexpected-error',
                message: (error as Error).message,
                manualActionRequired: false,
              };
        logger.warn('market sample failed', { ...lastFailure });
        report({
          type: 'market-failed',
          market: market.code,
          reason: lastFailure.reason,
          manualActionRequired: lastFailure.manualActionRequired,
        });
      }
      if (round < sampleCount - 1) await sleep(delayMs);
    }

    // A market is only a failure when every one of its rounds failed; a single
    // bad round among several is absorbed by the median.
    if (rounds.length > 0) roundsByMarket.set(market.code, rounds);
    else {
      failures.push(
        lastFailure ?? {
          market: market.code,
          reason: 'no-samples',
          message: `Every sample for ${market.code} failed.`,
          manualActionRequired: false,
        },
      );
    }
  }

  report({ type: 'matching' });
  const representative = [...roundsByMarket.entries()].map(([, rounds]) => rounds[rounds.length - 1]!);
  const matchOptions: { anchorMarket?: MarketCode; preferRoomId?: number } = {
    anchorMarket: options.anchorMarket ?? (roundsByMarket.has(baseline) ? baseline : undefined),
  };
  if (criteria.roomId !== undefined) matchOptions.preferRoomId = criteria.roomId;
  const match = matchAcrossMarkets(representative, matchOptions);

  const hotel: ComparisonResult['hotel'] = {
    hotelId: criteria.hotelId,
    name: options.hotelName ?? null,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    adult: criteria.adult,
    children: criteria.children,
    roomQuantity: criteria.roomQuantity,
  };

  if (!match) {
    return {
      hotel,
      matchedOn: null,
      prices: [],
      cheapestMarket: null,
      savingVsJapan: null,
      targetCurrency,
      failures,
      unmatchedMarkets: [...roundsByMarket.keys()],
      matchQuality: null,
    };
  }

  report({ type: 'converting' });
  const prices: MarketPrice[] = [];
  const unmatched = [...match.unmatchedMarkets];

  for (const [market, offer] of match.offers) {
    const rounds = roundsByMarket.get(market) ?? [];
    const price = await buildMarketPrice(market, offer, rounds, criteria, targetCurrency, rateProvider);
    if (price) prices.push(price);
    else unmatched.push(market);
  }

  prices.sort((a, b) => a.convertedPrice - b.convertedPrice);

  const cheapest = prices[0] ?? null;
  const baselinePrice = prices.find((price) => price.market === baseline) ?? null;
  const savingVsJapan =
    cheapest && baselinePrice ? roundForCurrency(baselinePrice.convertedPrice - cheapest.convertedPrice, targetCurrency) : null;

  return {
    hotel,
    matchedOn: match.identity,
    prices,
    cheapestMarket: cheapest?.market ?? null,
    savingVsJapan,
    targetCurrency,
    failures,
    unmatchedMarkets: unmatched,
    matchQuality: { confidence: match.confidence, warnings: match.warnings },
  };
}

/**
 * MVP step 5: decide which offers from different markets are the same product.
 *
 * Room names are translated per market, so matching is done on IDs
 * (`physicalRoomId` / `roomId` / `roomCode`) and on the rate-plan conditions
 * that change what you actually get (meal, cancellation, payment, tax
 * inclusion). Names are carried for display only.
 */

import type { MarketCode, MarketSample, RoomOffer } from '../types.js';

export type MatchConfidence = 'exact' | 'probable';

export interface OfferMatch {
  /** One offer per market, all judged to be the same product. */
  offers: Map<MarketCode, RoomOffer>;
  identity: {
    physicalRoomId: number | null;
    roomId: number | null;
    roomCode: string | null;
    meal: RoomOffer['meal'];
    cancellation: RoomOffer['cancellation'];
    payment: RoomOffer['payment'];
    taxIncluded: boolean;
  };
  confidence: MatchConfidence;
  /** Markets that had no comparable offer. */
  unmatchedMarkets: MarketCode[];
  /** Human-readable notes, e.g. fields a market did not report. */
  warnings: string[];
}

/** Two ID fields agree, or at least one side did not report the field. */
function idCompatible(a: number | string | null, b: number | string | null): { ok: boolean; strict: boolean } {
  if (a === null || b === null) return { ok: true, strict: false };
  return { ok: a === b, strict: true };
}

function attributeCompatible<T extends string>(a: T, b: T, unknownValue: T): { ok: boolean; strict: boolean } {
  if (a === unknownValue || b === unknownValue) return { ok: true, strict: false };
  return { ok: a === b, strict: true };
}

interface Compatibility {
  ok: boolean;
  /** How many identity fields matched strictly (both sides reported them). */
  strictScore: number;
  warnings: string[];
}

/**
 * Whether two offers are the same sellable product.
 *
 * At least one ID field must match strictly — agreeing only by silence is not
 * a match.
 */
export function compareOffers(a: RoomOffer, b: RoomOffer): Compatibility {
  const warnings: string[] = [];
  let strictScore = 0;

  const checks: Array<[string, { ok: boolean; strict: boolean }]> = [
    ['physicalRoomId', idCompatible(a.physicalRoomId, b.physicalRoomId)],
    ['roomId', idCompatible(a.roomId, b.roomId)],
    ['roomCode', idCompatible(a.roomCode, b.roomCode)],
  ];
  for (const [field, result] of checks) {
    if (!result.ok) return { ok: false, strictScore: 0, warnings: [] };
    if (result.strict) strictScore += 1;
    else warnings.push(`${field} missing on one side`);
  }
  if (strictScore === 0) return { ok: false, strictScore: 0, warnings: [] };

  const attributes: Array<[string, { ok: boolean; strict: boolean }]> = [
    ['meal', attributeCompatible(a.meal, b.meal, 'unknown')],
    ['cancellation', attributeCompatible(a.cancellation, b.cancellation, 'unknown')],
    ['payment', attributeCompatible(a.payment, b.payment, 'unknown')],
  ];
  for (const [field, result] of attributes) {
    if (!result.ok) return { ok: false, strictScore: 0, warnings: [] };
    if (result.strict) strictScore += 1;
    else warnings.push(`${field} not reported by one market`);
  }

  if (a.taxIncluded !== b.taxIncluded) {
    return { ok: false, strictScore: 0, warnings: [] };
  }

  return { ok: true, strictScore, warnings };
}

function pickStrongest(candidates: RoomOffer[], anchor: RoomOffer): RoomOffer | null {
  let best: { offer: RoomOffer; score: number } | null = null;
  for (const candidate of candidates) {
    const result = compareOffers(anchor, candidate);
    if (!result.ok) continue;
    if (!best || result.strictScore > best.score) best = { offer: candidate, score: result.strictScore };
  }
  return best?.offer ?? null;
}

export interface MatchOptions {
  /**
   * Market whose offers seed the candidate list. Defaults to the first sample.
   * JP is a sensible anchor since savings are reported against Japan.
   */
  anchorMarket?: MarketCode;
  /** Prefer this room, e.g. the one preselected in the pasted URL. */
  preferRoomId?: number;
}

/**
 * Finds the offer that the largest number of markets have in common.
 *
 * Ties are broken by identity strength, then by the anchor market's price
 * (cheapest first) so the comparison lands on the headline rate rather than an
 * arbitrary suite.
 */
export function matchAcrossMarkets(samples: MarketSample[], options: MatchOptions = {}): OfferMatch | null {
  const usable = samples.filter((sample) => sample.offers.length > 0);
  if (usable.length === 0) return null;

  const anchor =
    (options.anchorMarket ? usable.find((sample) => sample.market === options.anchorMarket) : undefined) ?? usable[0]!;
  const others = usable.filter((sample) => sample.market !== anchor.market);

  let best: { match: OfferMatch; coverage: number; strict: number; price: number } | null = null;

  for (const candidate of anchor.offers) {
    const offers = new Map<MarketCode, RoomOffer>([[anchor.market, candidate]]);
    const unmatched: MarketCode[] = [];
    const warnings = new Set<string>();
    let strictTotal = 0;

    for (const sample of others) {
      const found = pickStrongest(sample.offers, candidate);
      if (!found) {
        unmatched.push(sample.market);
        continue;
      }
      const result = compareOffers(candidate, found);
      strictTotal += result.strictScore;
      for (const warning of result.warnings) warnings.add(`${sample.market}: ${warning}`);
      offers.set(sample.market, found);
    }

    const coverage = offers.size;
    const price = candidate.totalPrice ?? Number.POSITIVE_INFINITY;
    const preferred = options.preferRoomId !== undefined && candidate.roomId === options.preferRoomId;
    // A URL-preselected room outranks anything else with the same coverage.
    const coverageScore = coverage + (preferred ? 0.5 : 0);

    const isBetter =
      !best ||
      coverageScore > best.coverage ||
      (coverageScore === best.coverage && strictTotal > best.strict) ||
      (coverageScore === best.coverage && strictTotal === best.strict && price < best.price);

    if (isBetter) {
      const match: OfferMatch = {
        offers,
        identity: {
          physicalRoomId: candidate.physicalRoomId,
          roomId: candidate.roomId,
          roomCode: candidate.roomCode,
          meal: candidate.meal,
          cancellation: candidate.cancellation,
          payment: candidate.payment,
          taxIncluded: candidate.taxIncluded,
        },
        confidence: warnings.size === 0 ? 'exact' : 'probable',
        unmatchedMarkets: unmatched,
        warnings: [...warnings],
      };
      best = { match, coverage: coverageScore, strict: strictTotal, price };
    }
  }

  return best?.match ?? null;
}

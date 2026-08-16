/**
 * Market registry.
 *
 * Per the plan, the first iteration changes only host / locale / region and
 * pins the display currency; `proxy` exists so IP geolocation can be layered on
 * later (MVP step 10) without touching the worker.
 */

import type { MarketConfig, MarketCode, SearchCriteria } from '../types.js';
import { applyOverride, loadOverrides, type MarketOverride } from './overrides.js';

const DEFINITIONS: MarketConfig[] = [
  {
    code: 'JP',
    origin: 'https://jp.trip.com',
    locale: 'ja-JP',
    region: 'JP',
    defaultCurrency: 'JPY',
    acceptLanguage: 'ja-JP,ja;q=0.9,en;q=0.8',
  },
  {
    code: 'NL',
    origin: 'https://nl.trip.com',
    locale: 'nl-NL',
    region: 'NL',
    defaultCurrency: 'EUR',
    acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.8',
  },
  {
    code: 'FR',
    origin: 'https://fr.trip.com',
    locale: 'fr-FR',
    region: 'FR',
    defaultCurrency: 'EUR',
    acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
  },
  {
    code: 'US',
    origin: 'https://us.trip.com',
    locale: 'en-US',
    region: 'US',
    defaultCurrency: 'USD',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    code: 'SG',
    origin: 'https://sg.trip.com',
    locale: 'en-SG',
    region: 'SG',
    defaultCurrency: 'SGD',
    acceptLanguage: 'en-SG,en;q=0.9',
  },
  {
    code: 'TH',
    origin: 'https://th.trip.com',
    locale: 'th-TH',
    region: 'TH',
    defaultCurrency: 'THB',
    acceptLanguage: 'th-TH,th;q=0.9,en;q=0.8',
  },
  {
    code: 'HK',
    origin: 'https://hk.trip.com',
    locale: 'zh-HK',
    region: 'HK',
    defaultCurrency: 'HKD',
    acceptLanguage: 'zh-HK,zh;q=0.9,en;q=0.8',
  },
  {
    code: 'GB',
    origin: 'https://uk.trip.com',
    locale: 'en-GB',
    region: 'GB',
    defaultCurrency: 'GBP',
    acceptLanguage: 'en-GB,en;q=0.9',
  },
  {
    code: 'KR',
    origin: 'https://kr.trip.com',
    locale: 'ko-KR',
    region: 'KR',
    defaultCurrency: 'KRW',
    acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.8',
  },
];

const BY_CODE = new Map(DEFINITIONS.map((market) => [market.code, market]));

export const DEFAULT_MARKETS: MarketCode[] = ['JP', 'NL'];

/**
 * Deployment settings are read once at startup. Restart the process after
 * changing them, rather than having a request see a half-applied config.
 */
let overrides: Record<string, MarketOverride> = loadOverrides();

/** Re-reads the environment. Used by the tests and by the launcher script. */
export function reloadOverrides(env: NodeJS.ProcessEnv = process.env): void {
  overrides = loadOverrides(env);
}

export function listMarkets(): MarketConfig[] {
  return DEFINITIONS.map((market) => applyOverride({ ...market }, overrides[market.code]));
}

export function getMarket(code: MarketCode): MarketConfig {
  const market = BY_CODE.get(code.toUpperCase());
  if (!market) {
    throw new Error(`Unknown market "${code}". Known markets: ${[...BY_CODE.keys()].join(', ')}`);
  }
  // Copy so per-run overrides (proxy, currency) never mutate the registry.
  return applyOverride({ ...market }, overrides[market.code]);
}

export function isKnownMarket(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

/**
 * Builds the storefront hotel-detail URL.
 *
 * Used for two things: the page the worker opens to make Trip.com fire the
 * room-list call, and the "book in this market" link handed to the user.
 * `roomId` overrides the one in the criteria so the link can point at the
 * exact plan that was compared.
 */
export function buildHotelDetailUrl(market: MarketConfig, criteria: SearchCriteria, roomId?: number | null): string {
  const url = new URL('/hotels/detail/', market.origin);
  url.searchParams.set('hotelId', String(criteria.hotelId));
  url.searchParams.set('checkIn', criteria.checkIn);
  url.searchParams.set('checkOut', criteria.checkOut);
  url.searchParams.set('adult', String(criteria.adult));
  url.searchParams.set('children', String(criteria.children));
  if (criteria.childAges.length > 0) {
    url.searchParams.set('ages', criteria.childAges.join(','));
  }
  url.searchParams.set('crn', String(criteria.roomQuantity));
  url.searchParams.set('locale', market.locale);
  url.searchParams.set('curr', criteria.currency);
  const targetRoomId = roomId ?? criteria.roomId;
  if (targetRoomId) url.searchParams.set('roomId', String(targetRoomId));
  return url.toString();
}

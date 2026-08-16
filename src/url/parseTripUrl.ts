/**
 * MVP step 1: turn a pasted Trip.com URL into search criteria.
 *
 * Trip.com uses several spellings for the same parameter depending on which
 * page produced the link (detail page, list page, deeplink, campaign link), so
 * every field is looked up through a list of aliases rather than a single name.
 */

import type { SearchCriteria } from '../types.js';

export class TripUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TripUrlParseError';
  }
}

const HOTEL_ID_KEYS = ['hotelId', 'hotelid', 'hotel_id', 'id'];
const ROOM_ID_KEYS = ['roomId', 'roomid', 'room_id'];
const CHECK_IN_KEYS = ['checkIn', 'checkin', 'checkInDate', 'checkindate', 'startDate', 'cin'];
const CHECK_OUT_KEYS = ['checkOut', 'checkout', 'checkOutDate', 'checkoutdate', 'endDate', 'cout'];
const ADULT_KEYS = ['adult', 'adults', 'adultNum', 'adultnum'];
const CHILDREN_KEYS = ['children', 'child', 'childNum', 'childnum'];
const CHILD_AGES_KEYS = ['ages', 'childAges', 'childages', 'childrenAges'];
const ROOM_QUANTITY_KEYS = ['crn', 'roomQuantity', 'roomquantity', 'rooms', 'roomNum', 'roomnum'];
const CURRENCY_KEYS = ['curr', 'currency'];

/** Lower-cased parameter lookup, so `hotelid=` and `hotelId=` both resolve. */
function collectParams(url: URL): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (value === '') continue;
    const lower = key.toLowerCase();
    if (!params.has(lower)) params.set(lower, value);
  }
  // Some Trip.com links carry a second query string inside the hash fragment.
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.includes('=') ? hash : '';
  if (hashQuery) {
    for (const [key, value] of new URLSearchParams(hashQuery)) {
      if (value === '') continue;
      const lower = key.toLowerCase();
      if (!params.has(lower)) params.set(lower, value);
    }
  }
  return params;
}

function pick(params: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key.toLowerCase());
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Accepts `2026-09-15`, `2026/09/15` and `20260915`. */
export function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (!match) match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  // Reject impossible dates like 2026-02-31, which round-trip differently.
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return undefined;
  return iso;
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function toNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseChildAges(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,|]/)
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((age) => Number.isFinite(age) && age >= 0 && age <= 17);
}

/** `.../hotels/detail/1234567.html` and `.../hotels/2848471/` style links. */
function hotelIdFromPath(pathname: string): number | undefined {
  const patterns = [/\/hotels?\/(?:detail\/)?(\d{4,})(?:\.html)?/i, /\/hotel[s]?-(\d{4,})/i];
  for (const pattern of patterns) {
    const match = pattern.exec(pathname);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface ParseOptions {
  /** Currency the comparison is displayed in. Defaults to JPY. */
  targetCurrency?: string;
  /** Used to default the stay when the URL carries no dates. */
  today?: Date;
}

/**
 * Extracts hotel, dates and occupancy from a Trip.com URL.
 *
 * Missing dates fall back to "30 nights out, 1 night stay" so a bare detail
 * link still produces a runnable comparison; everything else that is missing
 * takes the Trip.com default (2 adults, 1 room).
 */
export function parseTripUrl(rawUrl: string, options: ParseOptions = {}): SearchCriteria {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new TripUrlParseError(`Not a valid URL: ${rawUrl}`);
  }

  if (!/(^|\.)trip\.com$/i.test(url.hostname)) {
    throw new TripUrlParseError(`Not a Trip.com URL: ${url.hostname}`);
  }

  const params = collectParams(url);

  const hotelIdRaw = pick(params, HOTEL_ID_KEYS);
  const hotelId = hotelIdRaw ? Number.parseInt(hotelIdRaw, 10) : hotelIdFromPath(url.pathname);
  if (!hotelId || !Number.isFinite(hotelId)) {
    throw new TripUrlParseError('Could not find hotelId in the URL. Paste a hotel detail URL.');
  }

  const today = options.today ?? new Date();
  const todayIso = today.toISOString().slice(0, 10);

  let checkIn = normalizeDate(pick(params, CHECK_IN_KEYS));
  let checkOut = normalizeDate(pick(params, CHECK_OUT_KEYS));
  if (!checkIn) checkIn = addDays(todayIso, 30);
  if (!checkOut || checkOut <= checkIn) checkOut = addDays(checkIn, 1);

  const childAges = parseChildAges(pick(params, CHILD_AGES_KEYS));
  const children = toNonNegativeInt(pick(params, CHILDREN_KEYS), childAges.length);

  const roomIdRaw = pick(params, ROOM_ID_KEYS);
  const roomId = roomIdRaw ? Number.parseInt(roomIdRaw, 10) : undefined;

  const currency = (options.targetCurrency ?? pick(params, CURRENCY_KEYS) ?? 'JPY').toUpperCase();

  const criteria: SearchCriteria = {
    hotelId,
    checkIn,
    checkOut,
    adult: toPositiveInt(pick(params, ADULT_KEYS), 2),
    children,
    childAges,
    roomQuantity: toPositiveInt(pick(params, ROOM_QUANTITY_KEYS), 1),
    currency,
  };
  if (roomId && Number.isFinite(roomId)) criteria.roomId = roomId;
  return criteria;
}

/**
 * MVP step 4: normalize a `getHotelRoomListOversea` response into `RoomOffer`s.
 *
 * This file is the ONLY place that knows Trip.com's payload shape. It is
 * deliberately tolerant: the response nests rate plans under physical rooms and
 * the exact key names drift between releases and A/B buckets, so instead of a
 * fixed path we walk the tree, treat any node carrying a room identity plus a
 * price as an offer, and let identity fields (`physicalRoomId`, `roomName`)
 * cascade down from ancestors.
 */

import type { CancellationKind, MealKind, PaymentKind, RoomOffer, SearchCriteria } from '../types.js';

/** Matches the room-list endpoint on any market host. */
export const ROOM_LIST_URL_PATTERN = /\/restapi\/soa2\/\d+\/getHotelRoomList\w*/i;

export function isRoomListUrl(url: string): boolean {
  return ROOM_LIST_URL_PATTERN.test(url);
}

type Json = unknown;
type JsonObject = Record<string, unknown>;

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Case-insensitive key lookup, since casing is not stable across releases. */
function get(node: JsonObject, keys: string[]): unknown {
  const lowered = new Map<string, unknown>();
  for (const [key, value] of Object.entries(node)) lowered.set(key.toLowerCase(), value);
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase());
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Strip currency symbols, thin spaces and thousands separators.
    const cleaned = value.replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '');
    const parsed = Number.parseFloat(cleaned.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function int(value: unknown): number | null {
  const parsed = num(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (['true', 'y', 'yes', '1'].includes(lower)) return true;
    if (['false', 'n', 'no', '0'].includes(lower)) return false;
  }
  return null;
}

const PRICE_CONTAINER_KEYS = ['priceInfo', 'price', 'priceDetail', 'priceDetailInfo', 'roomPrice', 'saleInfo', 'amountInfo'];

/**
 * Reads a numeric field that may sit directly on the node or one level down in
 * a price container (`priceInfo.totalPrice`, `price.amount`, ...).
 */
function priceField(node: JsonObject, keys: string[]): number | null {
  const direct = num(get(node, keys));
  if (direct !== null) return direct;
  for (const containerKey of PRICE_CONTAINER_KEYS) {
    const container = get(node, [containerKey]);
    if (isObject(container)) {
      const nested = num(get(container, keys));
      if (nested !== null) return nested;
      // `price: { amount: ... }` — one more level for wrapper objects.
      for (const inner of Object.values(container)) {
        if (isObject(inner)) {
          const deep = num(get(inner, keys));
          if (deep !== null) return deep;
        }
      }
    }
  }
  return null;
}

/** Sub-objects a rate plan hangs its details off. Searched one level deep. */
const DETAIL_CONTAINER_KEYS = [
  ...PRICE_CONTAINER_KEYS,
  'roomInfo',
  'basicRoomInfo',
  'saleRoomInfo',
  'policyInfo',
  'policy',
  'cancelPolicy',
  'cancelPolicyInfo',
  'cancellationPolicy',
  'mealInfo',
  'breakfastInfo',
  'paymentInfo',
];

function stringField(node: JsonObject, keys: string[]): string | null {
  const direct = str(get(node, keys));
  if (direct !== null) return direct;
  for (const containerKey of DETAIL_CONTAINER_KEYS) {
    const container = get(node, [containerKey]);
    if (isObject(container)) {
      const nested = str(get(container, keys));
      if (nested !== null) return nested;
    }
  }
  return null;
}

function flagField(node: JsonObject, keys: string[]): boolean | null {
  const direct = bool(get(node, keys));
  if (direct !== null) return direct;
  for (const containerKey of DETAIL_CONTAINER_KEYS) {
    const container = get(node, [containerKey]);
    if (isObject(container)) {
      const nested = bool(get(container, keys));
      if (nested !== null) return nested;
    }
  }
  return null;
}

function intField(node: JsonObject, keys: string[]): number | null {
  const direct = int(get(node, keys));
  if (direct !== null) return direct;
  for (const containerKey of DETAIL_CONTAINER_KEYS) {
    const container = get(node, [containerKey]);
    if (isObject(container)) {
      const nested = int(get(container, keys));
      if (nested !== null) return nested;
    }
  }
  return null;
}

/*
 * Meal / cancellation wording is localized per market, so codes are preferred
 * and keyword matching is only the fallback. Keywords cover the MVP markets.
 */

const BREAKFAST_WORDS = /breakfast|petit[- ]d[ée]jeuner|ontbijt|frühstück|desayuno|朝食|조식|早餐|อาหารเช้า/i;
const HALF_BOARD_WORDS = /half[- ]board|demi[- ]pension|halfpension|夕食|ハーフボード|半食宿/i;
const FULL_BOARD_WORDS = /full[- ]board|pension compl|volpension|全食宿/i;
const ALL_INCLUSIVE_WORDS = /all[- ]inclusive|tout inclus|オールインクルーシブ/i;
const NO_MEAL_WORDS = /no meal|room only|sans repas|geen ontbijt|食事なし|朝食なし|无餐|无早餐/i;

export function normalizeMeal(raw: string | null, breakfastCount: number | null): MealKind {
  if (raw) {
    if (ALL_INCLUSIVE_WORDS.test(raw)) return 'all-inclusive';
    if (FULL_BOARD_WORDS.test(raw)) return 'full-board';
    if (HALF_BOARD_WORDS.test(raw)) return 'half-board';
    if (NO_MEAL_WORDS.test(raw)) return 'room-only';
    if (BREAKFAST_WORDS.test(raw)) return 'breakfast';
  }
  if (breakfastCount !== null) return breakfastCount > 0 ? 'breakfast' : 'room-only';
  return 'unknown';
}

const FREE_CANCEL_WORDS = /free cancel|annulation gratuite|gratis annuleren|無料キャンセル|キャンセル無料|免费取消|무료 취소|ยกเลิกฟรี/i;
const NON_REFUNDABLE_WORDS = /non[- ]refundable|no refund|non remboursable|niet[- ]restitueerbaar|返金不可|キャンセル不可|不可退款|환불 불가|ไม่สามารถคืนเงิน/i;

export function normalizeCancellation(raw: string | null, freeFlag: boolean | null): CancellationKind {
  if (freeFlag === true) return 'free';
  if (raw) {
    if (NON_REFUNDABLE_WORDS.test(raw)) return 'non-refundable';
    if (FREE_CANCEL_WORDS.test(raw)) return 'free';
    return 'conditional';
  }
  if (freeFlag === false) return 'non-refundable';
  return 'unknown';
}

const PAY_AT_HOTEL_WORDS = /pay at (the )?(hotel|property)|payer à l|betalen bij|現地払い|現地決済|到店付款|호텔에서 결제/i;
const PREPAY_WORDS = /prepay|pay now|prépay|vooruitbetaling|事前決済|オンライン決済|在线支付|선결제/i;

export function normalizePayment(raw: string | null, prepayFlag: boolean | null): PaymentKind {
  if (prepayFlag === true) return 'prepay';
  if (prepayFlag === false) return 'pay-at-hotel';
  if (raw) {
    if (PAY_AT_HOTEL_WORDS.test(raw)) return 'pay-at-hotel';
    if (PREPAY_WORDS.test(raw)) return 'prepay';
  }
  return 'unknown';
}

interface InheritedContext {
  physicalRoomId: number | null;
  roomName: string | null;
  hotelId: number | null;
}

/** True when the node carries a room identity — i.e. it may be an offer. */
function hasRoomIdentity(node: JsonObject): boolean {
  return (
    get(node, ['roomId', 'saleRoomId', 'subRoomId']) !== undefined ||
    get(node, ['roomCode', 'planCode', 'ratePlanCode']) !== undefined
  );
}

function readOffer(node: JsonObject, context: InheritedContext, criteria: SearchCriteria): RoomOffer | null {
  const roomId = int(get(node, ['roomId', 'saleRoomId', 'subRoomId']));
  const roomCode = str(get(node, ['roomCode', 'planCode', 'ratePlanCode']));
  if (roomId === null && roomCode === null) return null;

  const totalPrice =
    priceField(node, ['totalPrice', 'totalAmount', 'amountTotal', 'sumPrice']) ??
    priceField(node, ['salePrice', 'price', 'amount', 'displayPrice', 'averagePrice']);
  if (totalPrice === null) return null;

  const basePrice = priceField(node, ['price', 'salePrice', 'basePrice', 'amount', 'displayPrice']);
  const tax = priceField(node, ['tax', 'taxAndFee', 'taxFee', 'taxes', 'serviceFee']);
  const originalPrice = priceField(node, ['originalPrice', 'marketPrice', 'strikePrice', 'crossedPrice']);

  const remain = intField(node, ['remainRoomQuantity', 'remainQuantity', 'remainRooms', 'inventory', 'stock']);
  const availabilityFlag = flagField(node, ['availability', 'available', 'isAvailable', 'bookable', 'canBook']);
  // A zero-inventory offer is still returned by the API; treat it as sold out.
  const availability = availabilityFlag ?? (remain === null ? true : remain > 0);

  const mealRaw = stringField(node, ['meal', 'mealDesc', 'mealName', 'breakfastDesc', 'breakfastName', 'mealType']);
  const breakfastCount = intField(node, ['breakfastCount', 'breakfastNum', 'breakfastQuantity']);
  const cancellationRaw = stringField(node, [
    'cancellation',
    'cancelDesc',
    'cancelPolicy',
    'cancelPolicyDesc',
    'cancellationPolicy',
    'refundDesc',
  ]);
  const freeCancelFlag = flagField(node, ['freeCancel', 'isFreeCancel', 'cancelFree', 'refundable']);
  const paymentRaw = stringField(node, ['payment', 'paymentType', 'payType', 'paymentDesc', 'paymentMethod']);
  const prepayFlag = flagField(node, ['prepay', 'isPrepay', 'payOnline']);

  const taxIncludedFlag = flagField(node, ['taxIncluded', 'isTaxIncluded', 'includeTax', 'priceWithTax']);

  return {
    hotelId: context.hotelId ?? criteria.hotelId,
    physicalRoomId: int(get(node, ['physicalRoomId', 'physicalRoomID', 'baseRoomId'])) ?? context.physicalRoomId,
    roomId,
    roomCode,
    roomName: stringField(node, ['roomName', 'name', 'roomTypeName']) ?? context.roomName,
    availability,
    remainRoomQuantity: remain,
    currency: stringField(node, ['currency', 'currencyCode', 'curr']) ?? criteria.currency,
    price: basePrice,
    tax,
    totalPrice,
    originalPrice,
    meal: normalizeMeal(mealRaw, breakfastCount),
    mealRaw,
    cancellation: normalizeCancellation(cancellationRaw, freeCancelFlag),
    cancellationRaw,
    payment: normalizePayment(paymentRaw, prepayFlag),
    // When the API says nothing, assume tax is included only if it reported a
    // tax amount separately folded into the total.
    taxIncluded: taxIncludedFlag ?? (tax !== null && basePrice !== null && Math.abs(basePrice + tax - totalPrice) < 0.5),
  };
}

function walk(node: Json, context: InheritedContext, criteria: SearchCriteria, out: RoomOffer[], seen: Set<object>): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, context, criteria, out, seen);
    return;
  }
  if (!isObject(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  const nextContext: InheritedContext = {
    physicalRoomId: int(get(node, ['physicalRoomId', 'physicalRoomID', 'baseRoomId'])) ?? context.physicalRoomId,
    roomName: str(get(node, ['roomName', 'roomTypeName'])) ?? context.roomName,
    hotelId: int(get(node, ['hotelId', 'hotelID'])) ?? context.hotelId,
  };

  if (hasRoomIdentity(node)) {
    const offer = readOffer(node, nextContext, criteria);
    if (offer) {
      out.push(offer);
      // Rate plans never nest inside another rate plan, so stop descending.
      return;
    }
  }

  for (const value of Object.values(node)) {
    if (isObject(value) || Array.isArray(value)) walk(value, nextContext, criteria, out, seen);
  }
}

/** Drops duplicates produced by the API listing the same plan in several sections. */
function dedupe(offers: RoomOffer[]): RoomOffer[] {
  const byKey = new Map<string, RoomOffer>();
  for (const offer of offers) {
    const key = [offer.physicalRoomId, offer.roomId, offer.roomCode, offer.totalPrice, offer.meal, offer.cancellation].join('|');
    if (!byKey.has(key)) byKey.set(key, offer);
  }
  return [...byKey.values()];
}

/** Normalizes a raw room-list payload into offers. Never throws on shape drift. */
export function extractOffers(payload: unknown, criteria: SearchCriteria): RoomOffer[] {
  const offers: RoomOffer[] = [];
  walk(payload, { physicalRoomId: null, roomName: null, hotelId: null }, criteria, offers, new Set());
  return dedupe(offers);
}

/** Offers that can actually be booked for the requested room quantity. */
export function sellableOffers(offers: RoomOffer[], roomQuantity: number): RoomOffer[] {
  return offers.filter(
    (offer) =>
      offer.availability &&
      offer.totalPrice !== null &&
      offer.totalPrice > 0 &&
      (offer.remainRoomQuantity === null || offer.remainRoomQuantity >= roomQuantity),
  );
}

/** Best-effort hotel name for the response header. */
export function extractHotelName(payload: unknown): string | null {
  let found: string | null = null;
  const visit = (node: Json, depth: number): void => {
    if (found || depth > 8) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    const name = str(get(node, ['hotelName', 'hotelNameEn', 'name']));
    if (name && get(node, ['hotelId', 'hotelID']) !== undefined) {
      found = name;
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(payload, 0);
  return found;
}

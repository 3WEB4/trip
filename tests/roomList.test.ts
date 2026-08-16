import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractHotelName,
  extractOffers,
  isRoomListUrl,
  normalizeCancellation,
  normalizeMeal,
  sellableOffers,
} from '../src/extract/roomList.js';
import type { SearchCriteria } from '../src/types.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tokyo-2848471');

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

const load = (market: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${market}.json`), 'utf8'));

describe('isRoomListUrl', () => {
  it('matches the endpoint on any market host and any service id', () => {
    expect(isRoomListUrl('https://jp.trip.com/restapi/soa2/33269/getHotelRoomListOversea')).toBe(true);
    expect(isRoomListUrl('https://nl.trip.com/restapi/soa2/40000/getHotelRoomList?x=1')).toBe(true);
    expect(isRoomListUrl('https://jp.trip.com/restapi/soa2/33269/getHotelDetail')).toBe(false);
  });
});

describe('extractOffers', () => {
  it('flattens nested rate plans and inherits the physical room identity', () => {
    const offers = extractOffers(load('JP'), criteria);
    expect(offers).toHaveLength(4);

    const target = offers.find((offer) => offer.roomCode === 'Q72FXT-Z-1');
    expect(target).toMatchObject({
      hotelId: 2848471,
      physicalRoomId: 430120748,
      roomId: 1599611286,
      currency: 'JPY',
      price: 40245,
      tax: 4024,
      totalPrice: 44269,
      originalPrice: 48900,
      availability: true,
      remainRoomQuantity: 3,
      meal: 'room-only',
      cancellation: 'free',
      payment: 'prepay',
      taxIncluded: true,
    });
  });

  it('normalizes localized plan wording to the same values across markets', () => {
    const jp = extractOffers(load('JP'), criteria).find((offer) => offer.roomCode === 'K91LMP-Z-1');
    const nl = extractOffers(load('NL'), criteria).find((offer) => offer.roomCode === 'K91LMP-Z-1');
    expect(jp?.cancellation).toBe('non-refundable');
    expect(nl?.cancellation).toBe('non-refundable');
    expect(jp?.meal).toBe('room-only');
    expect(nl?.meal).toBe('room-only');
    // Names differ per market and must never be used for matching.
    expect(jp?.roomName).not.toBe(nl?.roomName);
  });

  it('drops sold-out plans from the sellable set', () => {
    const offers = extractOffers(load('JP'), criteria);
    expect(offers.some((offer) => offer.roomCode === 'JP-ONLY-1')).toBe(true);
    const sellable = sellableOffers(offers, 1);
    expect(sellable.some((offer) => offer.roomCode === 'JP-ONLY-1')).toBe(false);
    expect(sellable).toHaveLength(3);
  });

  it('drops plans without enough inventory for the requested room count', () => {
    const sellable = sellableOffers(extractOffers(load('JP'), criteria), 3);
    expect(sellable.map((offer) => offer.roomCode)).toEqual(['Q72FXT-Z-1']);
  });

  it('survives an unknown payload shape instead of throwing', () => {
    expect(extractOffers({ totallyDifferent: { nested: [1, 2, 3] } }, criteria)).toEqual([]);
    expect(extractOffers(null, criteria)).toEqual([]);
  });

  it('reads prices that sit directly on the plan node', () => {
    const flat = {
      hotelId: 2848471,
      rooms: [{ physicalRoomId: 1, roomId: 2, roomCode: 'A-1', totalPrice: 1000, currency: 'JPY' }],
    };
    expect(extractOffers(flat, criteria)[0]).toMatchObject({ roomCode: 'A-1', totalPrice: 1000 });
  });

  it('finds the hotel name', () => {
    expect(extractHotelName(load('JP'))).toBe('Example Hotel Tokyo');
  });
});

describe('plan normalization', () => {
  it('maps meal wording in every MVP market language', () => {
    expect(normalizeMeal('朝食付き', null)).toBe('breakfast');
    expect(normalizeMeal('Met ontbijt', null)).toBe('breakfast');
    expect(normalizeMeal('Petit-déjeuner inclus', null)).toBe('breakfast');
    expect(normalizeMeal('อาหารเช้า', null)).toBe('breakfast');
    expect(normalizeMeal('朝食なし', null)).toBe('room-only');
    expect(normalizeMeal(null, 2)).toBe('breakfast');
    expect(normalizeMeal(null, null)).toBe('unknown');
  });

  it('maps cancellation wording, preferring the explicit flag', () => {
    expect(normalizeCancellation('Gratis annuleren tot 13 september', null)).toBe('free');
    expect(normalizeCancellation('返金不可', null)).toBe('non-refundable');
    expect(normalizeCancellation('Conditions spéciales', null)).toBe('conditional');
    expect(normalizeCancellation('whatever the market says', true)).toBe('free');
    expect(normalizeCancellation(null, null)).toBe('unknown');
  });
});

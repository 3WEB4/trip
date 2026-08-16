import { describe, expect, it } from 'vitest';
import { compareOffers, matchAcrossMarkets } from '../src/match/matchOffers.js';
import type { MarketSample, RoomOffer } from '../src/types.js';

function offer(overrides: Partial<RoomOffer> = {}): RoomOffer {
  return {
    hotelId: 2848471,
    physicalRoomId: 430120748,
    roomId: 1599611286,
    roomCode: 'Q72FXT-Z-1',
    roomName: 'Deluxe Twin',
    availability: true,
    remainRoomQuantity: 3,
    currency: 'JPY',
    price: 40000,
    tax: 4269,
    totalPrice: 44269,
    originalPrice: 48900,
    meal: 'room-only',
    mealRaw: null,
    cancellation: 'free',
    cancellationRaw: null,
    payment: 'prepay',
    taxIncluded: true,
    ...overrides,
  };
}

const sample = (market: string, offers: RoomOffer[]): MarketSample => ({
  market,
  capturedAt: '2026-08-16T00:00:00.000Z',
  offers,
});

describe('compareOffers', () => {
  it('matches the same plan even when the localized name differs', () => {
    const result = compareOffers(offer(), offer({ roomName: 'デラックスツイン', totalPrice: 44750 }));
    expect(result.ok).toBe(true);
    expect(result.strictScore).toBe(6);
  });

  it('rejects a different room, plan code or physical room', () => {
    expect(compareOffers(offer(), offer({ roomCode: 'K91LMP-Z-1' })).ok).toBe(false);
    expect(compareOffers(offer(), offer({ roomId: 111 })).ok).toBe(false);
    expect(compareOffers(offer(), offer({ physicalRoomId: 999 })).ok).toBe(false);
  });

  it('rejects plans that differ in meal, cancellation, payment or tax inclusion', () => {
    expect(compareOffers(offer(), offer({ meal: 'breakfast' })).ok).toBe(false);
    expect(compareOffers(offer(), offer({ cancellation: 'non-refundable' })).ok).toBe(false);
    expect(compareOffers(offer(), offer({ payment: 'pay-at-hotel' })).ok).toBe(false);
    expect(compareOffers(offer(), offer({ taxIncluded: false })).ok).toBe(false);
  });

  it('tolerates a field one market does not report, but never matches on silence alone', () => {
    const partial = compareOffers(offer(), offer({ cancellation: 'unknown' }));
    expect(partial.ok).toBe(true);
    expect(partial.warnings).toContain('cancellation not reported by one market');

    const anonymous = compareOffers(
      offer({ physicalRoomId: null, roomId: null, roomCode: null }),
      offer({ physicalRoomId: null, roomId: null, roomCode: null }),
    );
    expect(anonymous.ok).toBe(false);
  });
});

describe('matchAcrossMarkets', () => {
  const cheapShared = offer({
    physicalRoomId: 430120801,
    roomId: 1599612044,
    roomCode: 'K91LMP-Z-1',
    cancellation: 'non-refundable',
    totalPrice: 41800,
  });

  it('picks the cheapest offer both markets sell', () => {
    const match = matchAcrossMarkets([
      sample('JP', [offer(), cheapShared]),
      sample('NL', [offer({ totalPrice: 44750 }), { ...cheapShared, totalPrice: 41250 }]),
    ]);
    expect(match?.offers.get('JP')?.roomCode).toBe('K91LMP-Z-1');
    expect(match?.offers.get('NL')?.totalPrice).toBe(41250);
    expect(match?.confidence).toBe('exact');
    expect(match?.unmatchedMarkets).toEqual([]);
  });

  it('honours a room preselected in the pasted URL over a cheaper one', () => {
    const match = matchAcrossMarkets(
      [sample('JP', [offer(), cheapShared]), sample('NL', [offer({ totalPrice: 44750 }), { ...cheapShared, totalPrice: 41250 }])],
      { preferRoomId: 1599611286 },
    );
    expect(match?.offers.get('JP')?.roomCode).toBe('Q72FXT-Z-1');
    expect(match?.offers.get('NL')?.totalPrice).toBe(44750);
  });

  it('prefers wider market coverage over a cheaper offer only one market has', () => {
    const jpOnly = offer({ roomId: 1, roomCode: 'JP-ONLY', physicalRoomId: 1, totalPrice: 10_000 });
    const match = matchAcrossMarkets([
      sample('JP', [jpOnly, offer()]),
      sample('NL', [offer({ totalPrice: 44750 })]),
      sample('FR', [offer({ totalPrice: 43900 })]),
    ]);
    expect(match?.identity.roomCode).toBe('Q72FXT-Z-1');
    expect(match?.offers.size).toBe(3);
  });

  it('reports markets that sell nothing comparable', () => {
    const match = matchAcrossMarkets([
      sample('JP', [offer()]),
      sample('NL', [offer({ roomId: 42, roomCode: 'OTHER', physicalRoomId: 42 })]),
    ]);
    expect(match?.unmatchedMarkets).toEqual(['NL']);
  });

  it('anchors on the requested market and flags a partial match', () => {
    const match = matchAcrossMarkets([sample('NL', [offer({ meal: 'unknown' })]), sample('JP', [offer()])], {
      anchorMarket: 'JP',
    });
    expect([...match!.offers.keys()][0]).toBe('JP');
    expect(match?.confidence).toBe('probable');
  });

  it('returns null when nothing was sampled', () => {
    expect(matchAcrossMarkets([])).toBeNull();
    expect(matchAcrossMarkets([sample('JP', [])])).toBeNull();
  });
});

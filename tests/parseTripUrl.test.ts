import { describe, expect, it } from 'vitest';
import { normalizeDate, parseTripUrl, TripUrlParseError } from '../src/url/parseTripUrl.js';

const TODAY = new Date('2026-08-16T00:00:00Z');

describe('parseTripUrl', () => {
  it('reads a hotel detail URL', () => {
    const criteria = parseTripUrl(
      'https://www.trip.com/hotels/detail/?cityId=228&hotelId=2848471&checkIn=2026-09-15&checkOut=2026-09-16&adult=2&children=0&crn=1',
      { today: TODAY },
    );
    expect(criteria).toMatchObject({
      hotelId: 2848471,
      checkIn: '2026-09-15',
      checkOut: '2026-09-16',
      adult: 2,
      children: 0,
      roomQuantity: 1,
      currency: 'JPY',
    });
  });

  it('accepts market hosts and lower-cased parameter spellings', () => {
    const criteria = parseTripUrl(
      'https://nl.trip.com/hotels/detail/?hotelid=2848471&checkin=2026/09/15&checkout=2026/09/16&adults=3&rooms=2',
      { today: TODAY },
    );
    expect(criteria).toMatchObject({ hotelId: 2848471, checkIn: '2026-09-15', adult: 3, roomQuantity: 2 });
  });

  it('carries a preselected roomId and child ages', () => {
    const criteria = parseTripUrl(
      'https://jp.trip.com/hotels/detail/?hotelId=2848471&roomId=1599611286&children=2&ages=4,9',
      { today: TODAY },
    );
    expect(criteria.roomId).toBe(1599611286);
    expect(criteria.children).toBe(2);
    expect(criteria.childAges).toEqual([4, 9]);
  });

  it('defaults to a one night stay 30 days out when the URL has no dates', () => {
    const criteria = parseTripUrl('https://www.trip.com/hotels/detail/?hotelId=2848471', { today: TODAY });
    expect(criteria.checkIn).toBe('2026-09-15');
    expect(criteria.checkOut).toBe('2026-09-16');
  });

  it('repairs a checkout that is not after check-in', () => {
    const criteria = parseTripUrl(
      'https://www.trip.com/hotels/detail/?hotelId=2848471&checkIn=2026-09-15&checkOut=2026-09-15',
      { today: TODAY },
    );
    expect(criteria.checkOut).toBe('2026-09-16');
  });

  it('finds hotelId in the path when there is no query parameter', () => {
    const criteria = parseTripUrl('https://jp.trip.com/hotels/detail/2848471.html', { today: TODAY });
    expect(criteria.hotelId).toBe(2848471);
  });

  it('rejects non-Trip.com URLs and URLs without a hotel', () => {
    expect(() => parseTripUrl('https://www.booking.com/hotel/jp/x.html')).toThrow(TripUrlParseError);
    expect(() => parseTripUrl('https://www.trip.com/hotels/list?city=228')).toThrow(TripUrlParseError);
  });

  it('normalizes the date formats Trip.com emits, and rejects impossible ones', () => {
    expect(normalizeDate('2026-09-15')).toBe('2026-09-15');
    expect(normalizeDate('2026/9/5')).toBe('2026-09-05');
    expect(normalizeDate('20260915')).toBe('2026-09-15');
    expect(normalizeDate('2026-02-31')).toBeUndefined();
    expect(normalizeDate('tomorrow')).toBeUndefined();
  });
});

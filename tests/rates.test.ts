import { describe, expect, it } from 'vitest';
import { convert, FrankfurterRateProvider, roundForCurrency, StaticRateProvider, UnknownRateError } from '../src/fx/rates.js';
import { median, spread } from '../src/util/stats.js';
import { redactHeaders, redactObject, redactUrl, REDACTED } from '../src/util/redact.js';

describe('StaticRateProvider', () => {
  const provider = new StaticRateProvider({ 'EUR:JPY': 170 });

  it('returns 1 for the same currency', async () => {
    await expect(provider.getRate('JPY', 'jpy')).resolves.toBe(1);
  });

  it('derives the inverse rate', async () => {
    await expect(provider.getRate('JPY', 'EUR')).resolves.toBeCloseTo(1 / 170, 10);
  });

  it('fails loudly on an unknown pair', async () => {
    await expect(provider.getRate('THB', 'JPY')).rejects.toBeInstanceOf(UnknownRateError);
  });
});

describe('FrankfurterRateProvider', () => {
  it('falls back to static rates when the endpoint is unreachable', async () => {
    const provider = new FrankfurterRateProvider(
      new StaticRateProvider({ 'EUR:JPY': 170 }),
      60_000,
      'http://127.0.0.1:1/unreachable',
    );
    await expect(provider.getRate('EUR', 'JPY')).resolves.toBe(170);
  });
});

describe('rounding and conversion', () => {
  it('rounds to whole units for zero-decimal currencies', () => {
    expect(roundForCurrency(44269.4, 'JPY')).toBe(44269);
    expect(roundForCurrency(250.005, 'EUR')).toBe(250.01);
  });

  it('converts and rounds in one step', async () => {
    await expect(convert(250, 'EUR', 'JPY', new StaticRateProvider({ 'EUR:JPY': 170.4 }))).resolves.toBe(42600);
  });
});

describe('stats', () => {
  it('takes the median of an odd and an even sample count', () => {
    expect(median([44269, 45000, 44500])).toBe(44500);
    expect(median([44269, 44750])).toBe(44509.5);
    expect(spread([44269, 45000, 44500])).toBe(731);
  });
});

describe('redaction', () => {
  it('never lets cookies or tokens through', () => {
    expect(redactHeaders({ cookie: 'abc', 'phantom-token': 'xyz', 'accept-language': 'ja-JP' })).toEqual({
      cookie: REDACTED,
      'phantom-token': REDACTED,
      'accept-language': 'ja-JP',
    });
    expect(redactObject({ head: { locale: 'ja-JP', auth: { token: 'secret' } } })).toEqual({
      head: { locale: 'ja-JP', auth: REDACTED },
    });
    expect(redactUrl('https://jp.trip.com/hotels/detail/?hotelId=1&sessionId=abc')).toContain(`sessionId=${encodeURIComponent(REDACTED)}`);
  });
});

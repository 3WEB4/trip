/**
 * MVP step 8: currency conversion.
 *
 * The first iteration pins the display currency to JPY on every market, so
 * conversion is usually a no-op. It still matters when a market refuses to
 * quote the requested currency and falls back to its own.
 */

export interface RateProvider {
  readonly name: string;
  /** Units of `to` per one unit of `from`. */
  getRate(from: string, to: string): Promise<number>;
}

export class UnknownRateError extends Error {
  constructor(from: string, to: string, provider: string) {
    super(`No ${from}->${to} rate available from ${provider}`);
    this.name = 'UnknownRateError';
  }
}

/** Rates supplied up front — used by tests and by offline runs. */
export class StaticRateProvider implements RateProvider {
  readonly name = 'static';
  /** `{ "EUR:JPY": 168.4 }`; inverses are derived automatically. */
  private readonly rates: Map<string, number>;

  constructor(rates: Record<string, number> = {}) {
    this.rates = new Map(Object.entries(rates).map(([pair, rate]) => [pair.toUpperCase(), rate]));
  }

  async getRate(from: string, to: string): Promise<number> {
    const source = from.toUpperCase();
    const target = to.toUpperCase();
    if (source === target) return 1;
    const direct = this.rates.get(`${source}:${target}`);
    if (direct !== undefined) return direct;
    const inverse = this.rates.get(`${target}:${source}`);
    if (inverse !== undefined && inverse !== 0) return 1 / inverse;
    throw new UnknownRateError(source, target, this.name);
  }
}

/**
 * Live rates from frankfurter.app (ECB reference rates, no API key).
 * Falls back to `fallback` when the host is unreachable, so an offline run
 * still produces a result instead of failing the whole comparison.
 */
export class FrankfurterRateProvider implements RateProvider {
  readonly name = 'frankfurter';
  private readonly cache = new Map<string, { rate: number; fetchedAt: number }>();

  constructor(
    private readonly fallback: RateProvider = new StaticRateProvider(),
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly endpoint = 'https://api.frankfurter.app',
  ) {}

  async getRate(from: string, to: string): Promise<number> {
    const source = from.toUpperCase();
    const target = to.toUpperCase();
    if (source === target) return 1;

    const key = `${source}:${target}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached.rate;

    try {
      const url = `${this.endpoint}/latest?from=${source}&to=${target}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { rates?: Record<string, number> };
      const rate = body.rates?.[target];
      if (typeof rate !== 'number' || !Number.isFinite(rate)) throw new Error('rate missing in response');
      this.cache.set(key, { rate, fetchedAt: Date.now() });
      return rate;
    } catch {
      return this.fallback.getRate(source, target);
    }
  }
}

/** Rounds to the precision the currency is actually quoted in. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);

export function roundForCurrency(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) return Math.round(amount);
  return Math.round(amount * 100) / 100;
}

export async function convert(amount: number, from: string, to: string, provider: RateProvider): Promise<number> {
  const rate = await provider.getRate(from, to);
  return roundForCurrency(amount * rate, to);
}

/**
 * Contract between the comparison pipeline and whatever actually gets prices.
 *
 * Keeping this an interface means the pipeline can be exercised against saved
 * fixtures without a browser, and the CDP worker can be swapped for a proxied
 * or remote worker later.
 */

import type { MarketConfig, MarketSample, SearchCriteria } from '../types.js';

export interface MarketFetcher {
  readonly name: string;
  /** Captures one room-list response for one market. */
  fetch(market: MarketConfig, criteria: SearchCriteria): Promise<MarketSample>;
  /** Releases browsers/pages. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * A market failed in a way the pipeline should report rather than retry.
 * `manualActionRequired` is true for CAPTCHA / HTTP 430 style blocks, which
 * are deliberately not worked around.
 */
export class MarketFetchError extends Error {
  constructor(
    readonly market: string,
    readonly reason: string,
    message: string,
    readonly manualActionRequired = false,
  ) {
    super(message);
    this.name = 'MarketFetchError';
  }
}

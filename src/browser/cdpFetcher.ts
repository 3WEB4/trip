/**
 * MVP steps 2-3: drive a real Chrome over CDP and capture the room-list
 * response the page produces.
 *
 * The internal API is never called directly. A freshly launched headless
 * Chrome gets HTTP 430 from Trip.com, so the worker attaches to a normal
 * Chrome that the operator already has running:
 *
 *   google-chrome --remote-debugging-port=9222 --user-data-dir=/path/to/profile
 *
 * Cookies and `phantom-token` therefore come from that profile and are never
 * read, logged or persisted by this code.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright-core';
import { buildHotelDetailUrl } from '../markets/markets.js';
import { extractHotelName, extractOffers, isRoomListUrl, sellableOffers } from '../extract/roomList.js';
import type { MarketConfig, MarketSample, SearchCriteria } from '../types.js';
import { logger } from '../util/logger.js';
import { redactUrl } from '../util/redact.js';
import { MarketFetchError, type MarketFetcher } from './fetcher.js';

export interface CdpFetcherOptions {
  /** CDP endpoint of an already-running Chrome. */
  endpointUrl?: string;
  /** How long to wait for the room-list response, in ms. */
  responseTimeoutMs?: number;
  /** Keep the page open after capture, so a human can solve a CAPTCHA. */
  keepPageOpen?: boolean;
}

/** Hotel names are only needed once; captured opportunistically. */
export interface CapturedMeta {
  hotelName: string | null;
}

const BLOCKED_STATUSES = new Set([403, 429, 430, 451]);

export class CdpMarketFetcher implements MarketFetcher {
  readonly name = 'chrome-cdp';
  private browser: Browser | null = null;
  private readonly endpointUrl: string;
  private readonly responseTimeoutMs: number;
  private readonly keepPageOpen: boolean;
  readonly meta: CapturedMeta = { hotelName: null };

  constructor(options: CdpFetcherOptions = {}) {
    this.endpointUrl = options.endpointUrl ?? process.env.CHROME_CDP_URL ?? 'http://127.0.0.1:9222';
    this.responseTimeoutMs = options.responseTimeoutMs ?? 45_000;
    this.keepPageOpen = options.keepPageOpen ?? false;
  }

  private async connect(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    try {
      this.browser = await chromium.connectOverCDP(this.endpointUrl);
    } catch (error) {
      throw new MarketFetchError(
        '-',
        'cdp-unreachable',
        `Could not attach to Chrome at ${this.endpointUrl}. Start Chrome with ` +
          `--remote-debugging-port=9222 --user-data-dir=<profile>. (${(error as Error).message})`,
        true,
      );
    }
    return this.browser;
  }

  /**
   * Reuses the running Chrome's existing context so the profile's cookies
   * apply; only falls back to a fresh context if none is exposed.
   */
  private async contextFor(browser: Browser): Promise<BrowserContext> {
    const existing = browser.contexts();
    if (existing.length > 0 && existing[0]) return existing[0];
    return browser.newContext();
  }

  async fetch(market: MarketConfig, criteria: SearchCriteria): Promise<MarketSample> {
    const browser = await this.connect();
    const context = await this.contextFor(browser);
    const page = await context.newPage();

    try {
      await page.setExtraHTTPHeaders({ 'Accept-Language': market.acceptLanguage });
      return await this.capture(page, market, criteria);
    } finally {
      if (!this.keepPageOpen) {
        await page.close().catch(() => undefined);
      }
    }
  }

  private async capture(page: Page, market: MarketConfig, criteria: SearchCriteria): Promise<MarketSample> {
    const targetUrl = buildHotelDetailUrl(market, criteria);
    logger.info('opening market page', { market: market.code, url: redactUrl(targetUrl) });

    let blocked: { status: number; url: string } | null = null;
    const payloadPromise = new Promise<{ payload: unknown; capturedAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new MarketFetchError(
            market.code,
            blocked ? `http-${blocked.status}` : 'timeout',
            blocked
              ? `Trip.com answered HTTP ${blocked.status} for ${market.code}; treat as blocked and retry manually.`
              : `No room-list response captured for ${market.code} within ${this.responseTimeoutMs}ms.`,
            blocked !== null,
          ),
        );
      }, this.responseTimeoutMs);

      const onResponse = (response: Response): void => {
        const url = response.url();
        if (!isRoomListUrl(url)) {
          // Any hard block on the storefront explains a later timeout.
          if (BLOCKED_STATUSES.has(response.status()) && url.includes(new URL(market.origin).hostname)) {
            blocked = { status: response.status(), url };
          }
          return;
        }

        const status = response.status();
        logger.info('room-list response', { market: market.code, status });

        if (status !== 200) {
          clearTimeout(timer);
          page.off('response', onResponse);
          reject(
            new MarketFetchError(
              market.code,
              `http-${status}`,
              `Room-list request returned HTTP ${status} for ${market.code}. ` +
                'CAPTCHA / 430 are not worked around — solve it in the attached Chrome and re-run.',
              BLOCKED_STATUSES.has(status),
            ),
          );
          return;
        }

        void response
          .json()
          .then((payload) => {
            clearTimeout(timer);
            page.off('response', onResponse);
            resolve({ payload, capturedAt: new Date().toISOString() });
          })
          .catch((error: Error) => {
            clearTimeout(timer);
            page.off('response', onResponse);
            reject(
              new MarketFetchError(
                market.code,
                'unreadable-body',
                `Room-list response for ${market.code} was not JSON: ${error.message}`,
              ),
            );
          });
      };

      page.on('response', onResponse);
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.responseTimeoutMs }).catch(() => {
      // The capture promise carries the real outcome; a slow document is fine.
    });

    const { payload, capturedAt } = await payloadPromise;

    if (this.meta.hotelName === null) {
      this.meta.hotelName = extractHotelName(payload);
    }

    const allOffers = extractOffers(payload, criteria);
    const offers = sellableOffers(allOffers, criteria.roomQuantity);
    logger.info('offers extracted', { market: market.code, total: allOffers.length, sellable: offers.length });

    if (offers.length === 0) {
      throw new MarketFetchError(
        market.code,
        'no-offers',
        `Room-list response for ${market.code} contained no bookable offers ` +
          `(${allOffers.length} parsed). Sold out, or Trip.com changed the payload shape — ` +
          'check src/extract/roomList.ts.',
      );
    }

    return { market: market.code, capturedAt, offers };
  }

  async close(): Promise<void> {
    // Only detach: the Chrome belongs to the operator, not to this process.
    if (this.browser?.isConnected()) await this.browser.close().catch(() => undefined);
    this.browser = null;
  }
}

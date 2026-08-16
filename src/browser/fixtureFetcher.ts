/**
 * Replays saved room-list responses instead of driving a browser.
 *
 * Used by the tests and by `--fixtures <dir>` on the CLI, so the whole
 * pipeline (extract → match → FX → rank) can be exercised offline and so a
 * Trip.com payload change can be reproduced from a captured file.
 *
 * Expected layout: one JSON file per market, named `<MARKET>.json`
 * (e.g. `JP.json`), each holding a raw `getHotelRoomListOversea` response.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractHotelName, extractOffers, sellableOffers } from '../extract/roomList.js';
import type { MarketConfig, MarketSample, SearchCriteria } from '../types.js';
import { MarketFetchError, type MarketFetcher } from './fetcher.js';

export class FixtureMarketFetcher implements MarketFetcher {
  readonly name = 'fixtures';
  readonly meta: { hotelName: string | null } = { hotelName: null };

  constructor(private readonly directory: string) {}

  async fetch(market: MarketConfig, criteria: SearchCriteria): Promise<MarketSample> {
    const path = join(this.directory, `${market.code}.json`);
    const capturedAt = await stat(path).then(
      (info) => info.mtime.toISOString(),
      () => {
        throw new MarketFetchError(market.code, 'fixture-missing', `No fixture at ${path}`);
      },
    );

    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new MarketFetchError(market.code, 'fixture-unreadable', `Could not parse ${path}: ${(error as Error).message}`);
    }

    if (this.meta.hotelName === null) this.meta.hotelName = extractHotelName(payload);

    const offers = sellableOffers(extractOffers(payload, criteria), criteria.roomQuantity);
    if (offers.length === 0) {
      throw new MarketFetchError(
        market.code,
        'no-offers',
        `Fixture ${path} contained no bookable offers for ${criteria.roomQuantity} room(s).`,
      );
    }
    return { market: market.code, capturedAt, offers };
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}

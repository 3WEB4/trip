#!/usr/bin/env node
/**
 * Preflight check for a real run.
 *
 *   npm run doctor                 -- checks every configured market
 *   npm run doctor -- --markets JP,NL
 *   npm run doctor -- --hotel 2848471
 *
 * For each market it reports whether its Chrome is attachable, which country
 * the exit IP resolves to (the thing that actually decides "which country is
 * cheapest"), and — with `--hotel` — whether Trip.com serves a room list to
 * that Chrome or blocks it.
 *
 * Nothing here works around a block: a 430 or a CAPTCHA is reported as a
 * finding for a human to deal with.
 */

import { chromium, type Browser } from 'playwright-core';
import { CdpMarketFetcher } from './browser/cdpFetcher.js';
import { MarketFetchError } from './browser/fetcher.js';
import { DEFAULT_MARKETS, getMarket, listMarkets } from './markets/markets.js';
import { describeProxy } from './markets/overrides.js';
import { parseTripUrl } from './url/parseTripUrl.js';
import type { MarketCode, MarketConfig, SearchCriteria } from './types.js';
import { setLogLevel } from './util/logger.js';

/** Returns the exit IP and its country as seen from inside that Chrome. */
const IP_LOOKUP_URL = process.env.IP_LOOKUP_URL ?? 'https://ipinfo.io/json';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface MarketReport {
  market: MarketCode;
  endpoint: string;
  proxy: string | null;
  chrome: { status: CheckStatus; detail: string };
  egress: { status: CheckStatus; detail: string; ip: string | null; country: string | null };
  tripcom: { status: CheckStatus; detail: string };
}

export interface DoctorReport {
  markets: MarketReport[];
  /** True when every market is ready for a real comparison. */
  ready: boolean;
  /** Distinct exit countries seen. One country across all markets is a warning. */
  distinctCountries: string[];
}

async function checkChrome(market: MarketConfig, endpoint: string): Promise<{ browser: Browser | null; result: MarketReport['chrome'] }> {
  try {
    const browser = await chromium.connectOverCDP(endpoint);
    const version = browser.version();
    return { browser, result: { status: 'ok', detail: `Chrome ${version}` } };
  } catch (error) {
    return {
      browser: null,
      result: {
        status: 'fail',
        detail: `attach failed: ${(error as Error).message.split('\n')[0]}`,
      },
    };
  }
}

async function checkEgress(browser: Browser, market: MarketConfig): Promise<MarketReport['egress']> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  try {
    const response = await page.goto(IP_LOOKUP_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response?.ok()) {
      return { status: 'warn', detail: `IP lookup returned HTTP ${response?.status() ?? '—'}`, ip: null, country: null };
    }

    const body = (await response.json()) as { ip?: string; country?: string };
    const ip = body.ip ?? null;
    const country = body.country?.toUpperCase() ?? null;

    if (!country) return { status: 'warn', detail: 'IP lookup returned no country', ip, country: null };

    const expected = market.expectedCountry ?? market.region;
    if (country === expected) {
      return { status: 'ok', detail: `exit IP in ${country}`, ip, country };
    }
    return {
      status: 'warn',
      detail: `exit IP in ${country}, expected ${expected} — prices will reflect ${country}, not ${expected}`,
      ip,
      country,
    };
  } catch (error) {
    return { status: 'warn', detail: `IP lookup failed: ${(error as Error).message.split('\n')[0]}`, ip: null, country: null };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function checkTripcom(market: MarketConfig, criteria: SearchCriteria): Promise<MarketReport['tripcom']> {
  const fetcher = new CdpMarketFetcher({ responseTimeoutMs: 45_000 });
  try {
    const sample = await fetcher.fetch(market, criteria);
    return { status: 'ok', detail: `room list received, ${sample.offers.length} bookable offers` };
  } catch (error) {
    if (error instanceof MarketFetchError) {
      return {
        status: error.manualActionRequired ? 'fail' : 'warn',
        detail: `${error.reason}: ${error.message.split('.')[0]}`,
      };
    }
    return { status: 'fail', detail: (error as Error).message.split('\n')[0]! };
  } finally {
    await fetcher.close();
  }
}

export interface DoctorOptions {
  markets?: MarketCode[];
  /** Hotel id or Trip.com URL to test a real room-list fetch against. */
  hotel?: string;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const codes = options.markets ?? DEFAULT_MARKETS;
  const reports: MarketReport[] = [];

  let criteria: SearchCriteria | null = null;
  if (options.hotel) {
    const url = /^\d+$/.test(options.hotel)
      ? `https://www.trip.com/hotels/detail/?hotelId=${options.hotel}`
      : options.hotel;
    criteria = parseTripUrl(url, { targetCurrency: 'JPY' });
  }

  for (const code of codes) {
    const market = getMarket(code);
    const endpoint = market.cdpUrl ?? process.env.CHROME_CDP_URL ?? 'http://127.0.0.1:9222';

    const { browser, result: chrome } = await checkChrome(market, endpoint);
    const report: MarketReport = {
      market: market.code,
      endpoint,
      proxy: describeProxy(market.proxy),
      chrome,
      egress: { status: 'skip', detail: 'skipped — Chrome not reachable', ip: null, country: null },
      tripcom: { status: 'skip', detail: criteria ? 'skipped — Chrome not reachable' : 'skipped — pass --hotel to test' },
    };

    if (browser) {
      try {
        report.egress = await checkEgress(browser, market);
        if (criteria) report.tripcom = await checkTripcom(market, criteria);
      } finally {
        await browser.close().catch(() => undefined);
      }
    }

    reports.push(report);
  }

  const countries = [...new Set(reports.map((report) => report.egress.country).filter((value): value is string => Boolean(value)))];

  return {
    markets: reports,
    ready: reports.every((report) => report.chrome.status === 'ok' && report.tripcom.status !== 'fail'),
    distinctCountries: countries,
  };
}

const ICONS: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' };

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];

  for (const market of report.markets) {
    lines.push(`${market.market}  ${market.endpoint}${market.proxy ? `  via ${market.proxy}` : ''}`);
    lines.push(`  ${ICONS[market.chrome.status]} chrome    ${market.chrome.detail}`);
    lines.push(`  ${ICONS[market.egress.status]} exit IP   ${market.egress.detail}`);
    lines.push(`  ${ICONS[market.tripcom.status]} trip.com  ${market.tripcom.detail}`);
    lines.push('');
  }

  if (report.markets.length > 1 && report.distinctCountries.length === 1) {
    lines.push(
      `! すべての市場が同じIP（${report.distinctCountries[0]}）から出ています。` +
        'ホスト・locale・region だけの比較になり、「どの国からアクセスすると安いか」の検証にはなりません。',
    );
    lines.push('  市場ごとに proxy を設定してください（README「市場別IP」）。');
    lines.push('');
  }

  lines.push(report.ready ? '✓ 比較を実行できる状態です。' : '✗ 未解決の問題があります。上の ✗ を先に解消してください。');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const options: DoctorOptions = {};
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--markets') options.markets = argv[++index]?.split(',').map((code) => code.trim().toUpperCase()) ?? [];
    else if (arg === '--hotel') options.hotel = argv[++index];
    else if (arg === '--all') options.markets = listMarkets().map((market) => market.code);
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: npm run doctor -- [--markets JP,NL] [--all] [--hotel <hotelId|URL>] [--json]\n',
      );
      return 0;
    }
  }

  setLogLevel('warn');
  const report = await runDoctor(options);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
  return report.ready ? 0 : 1;
}

const isEntryPoint = process.argv[1]?.endsWith('doctor.ts') || process.argv[1]?.endsWith('doctor.js');
if (isEntryPoint) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

/**
 * Per-market deployment settings (MVP step 10).
 *
 * The registry in `markets.ts` holds what Trip.com itself defines — host,
 * locale, region. Which Chrome serves a market and which exit IP it sits
 * behind is a property of *your* deployment, so it comes from the environment
 * or from a JSON file instead of being baked into the code.
 *
 * Environment form (one line per market):
 *
 *   TRIP_MARKET_JP_CDP=http://127.0.0.1:9222
 *   TRIP_MARKET_JP_PROXY=http://user:pass@jp-exit.example:8000
 *   TRIP_MARKET_JP_COUNTRY=JP
 *
 * File form, via `TRIP_MARKETS_FILE=./markets.local.json`:
 *
 *   { "JP": { "cdpUrl": "...", "proxy": "...", "expectedCountry": "JP" } }
 *
 * Proxy credentials are never logged; only the host is ever printed.
 */

import { readFileSync } from 'node:fs';
import type { MarketCode, MarketConfig } from '../types.js';

export interface MarketOverride {
  cdpUrl?: string;
  proxy?: string;
  expectedCountry?: string;
}

const ENV_PREFIX = 'TRIP_MARKET_';
const ENV_SUFFIXES: Array<[string, keyof MarketOverride]> = [
  ['_CDP', 'cdpUrl'],
  ['_PROXY', 'proxy'],
  ['_COUNTRY', 'expectedCountry'],
];

function fromFile(path: string): Record<string, MarketOverride> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, MarketOverride>;
    const out: Record<string, MarketOverride> = {};
    for (const [code, override] of Object.entries(parsed)) out[code.toUpperCase()] = override;
    return out;
  } catch (error) {
    throw new Error(`Could not read market overrides from ${path}: ${(error as Error).message}`);
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Record<string, MarketOverride> {
  const out: Record<string, MarketOverride> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || !value) continue;
    const suffix = ENV_SUFFIXES.find(([end]) => key.endsWith(end));
    if (!suffix) continue;
    const code = key.slice(ENV_PREFIX.length, key.length - suffix[0].length).toUpperCase();
    if (!code) continue;
    out[code] = { ...out[code], [suffix[1]]: value };
  }
  return out;
}

/** Env wins over the file, so a single variable can override a deployment file. */
export function loadOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, MarketOverride> {
  const file = env.TRIP_MARKETS_FILE ? fromFile(env.TRIP_MARKETS_FILE) : {};
  const environment = fromEnv(env);
  const merged: Record<string, MarketOverride> = { ...file };
  for (const [code, override] of Object.entries(environment)) {
    merged[code] = { ...merged[code], ...override };
  }
  return merged;
}

export function applyOverride(market: MarketConfig, override: MarketOverride | undefined): MarketConfig {
  if (!override) return market;
  return {
    ...market,
    ...(override.cdpUrl ? { cdpUrl: override.cdpUrl } : {}),
    ...(override.proxy ? { proxy: override.proxy } : {}),
    ...(override.expectedCountry ? { expectedCountry: override.expectedCountry.toUpperCase() } : {}),
  };
}

/** Markets that have been given their own Chrome or exit proxy. */
export function configuredMarkets(overrides: Record<string, MarketOverride>): MarketCode[] {
  return Object.entries(overrides)
    .filter(([, override]) => override.cdpUrl ?? override.proxy)
    .map(([code]) => code);
}

/** Strips credentials so a proxy can be shown in logs and the doctor report. */
export function describeProxy(proxy: string | undefined): string | null {
  if (!proxy) return null;
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(unparsable proxy)';
  }
}

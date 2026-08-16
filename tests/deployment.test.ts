import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { getMarket, listMarkets, reloadOverrides } from '../src/markets/markets.js';
import { applyOverride, configuredMarkets, describeProxy, loadOverrides } from '../src/markets/overrides.js';
import { formatReport, type DoctorReport } from '../src/doctor.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'tokyo-2848471');

afterEach(() => reloadOverrides({ TRIP_SKIP_LAUNCHER_FILE: '1' } as NodeJS.ProcessEnv));

describe('market overrides', () => {
  it('reads per-market Chrome, proxy and country from the environment', () => {
    const overrides = loadOverrides({
      TRIP_MARKET_JP_CDP: 'http://127.0.0.1:9222',
      TRIP_MARKET_NL_CDP: 'http://127.0.0.1:9223',
      TRIP_MARKET_NL_PROXY: 'http://user:secret@nl-exit.example:8000',
      TRIP_MARKET_NL_COUNTRY: 'nl',
      UNRELATED: 'x',
      TRIP_SKIP_LAUNCHER_FILE: '1',
    } as NodeJS.ProcessEnv);

    expect(overrides).toEqual({
      JP: { cdpUrl: 'http://127.0.0.1:9222' },
      NL: { cdpUrl: 'http://127.0.0.1:9223', proxy: 'http://user:secret@nl-exit.example:8000', expectedCountry: 'nl' },
    });
    expect(configuredMarkets(overrides).sort()).toEqual(['JP', 'NL']);
  });

  it('reads a deployment file and lets the environment win over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trip-overrides-'));
    const file = join(dir, 'markets.json');
    writeFileSync(file, JSON.stringify({ jp: { cdpUrl: 'http://file:9222', proxy: 'http://file-proxy:8000' } }));

    const overrides = loadOverrides({
      TRIP_MARKETS_FILE: file,
      TRIP_MARKET_JP_CDP: 'http://env:9999',
      TRIP_SKIP_LAUNCHER_FILE: '1',
    } as NodeJS.ProcessEnv);

    expect(overrides.JP).toEqual({ cdpUrl: 'http://env:9999', proxy: 'http://file-proxy:8000' });
  });

  it('applies overrides through the registry and uppercases the country', () => {
    reloadOverrides({
      TRIP_MARKET_NL_CDP: 'http://127.0.0.1:9223',
      TRIP_MARKET_NL_COUNTRY: 'nl',
      TRIP_SKIP_LAUNCHER_FILE: '1',
    } as NodeJS.ProcessEnv);

    const nl = getMarket('NL');
    expect(nl.cdpUrl).toBe('http://127.0.0.1:9223');
    expect(nl.expectedCountry).toBe('NL');
    // Untouched markets keep the registry values.
    expect(getMarket('JP').cdpUrl).toBeUndefined();
    expect(listMarkets().find((market) => market.code === 'NL')?.cdpUrl).toBe('http://127.0.0.1:9223');
  });

  it('never exposes proxy credentials', () => {
    expect(describeProxy('http://user:secret@nl-exit.example:8000')).toBe('http://nl-exit.example:8000');
    expect(describeProxy(undefined)).toBeNull();
    expect(describeProxy('not a url')).toBe('(unparsable proxy)');
  });

  it('picks up the endpoints the launcher recorded, and lets env override them', () => {
    const launcherFile = join(import.meta.dirname, '..', '.trip-chrome.json');
    writeFileSync(launcherFile, JSON.stringify({ JP: { cdpUrl: 'http://127.0.0.1:9222' }, NL: { cdpUrl: 'http://127.0.0.1:9223' } }));

    try {
      // No environment at all: the launcher's file alone must wire the markets
      // up, since forgetting to export used to point every market at one Chrome.
      expect(loadOverrides({} as NodeJS.ProcessEnv)).toEqual({
        JP: { cdpUrl: 'http://127.0.0.1:9222' },
        NL: { cdpUrl: 'http://127.0.0.1:9223' },
      });

      const overridden = loadOverrides({ TRIP_MARKET_NL_CDP: 'http://elsewhere:9999' } as NodeJS.ProcessEnv);
      expect(overridden.NL?.cdpUrl).toBe('http://elsewhere:9999');
      expect(overridden.JP?.cdpUrl).toBe('http://127.0.0.1:9222');
    } finally {
      rmSync(launcherFile, { force: true });
    }
  });

  it('leaves a market untouched when there is no override', () => {
    const market = getMarket('JP');
    expect(applyOverride(market, undefined)).toEqual(market);
  });
});

describe('doctor report formatting', () => {
  const report: DoctorReport = {
    ready: true,
    distinctCountries: ['JP'],
    markets: [
      {
        market: 'JP',
        endpoint: 'http://127.0.0.1:9222',
        proxy: null,
        chrome: { status: 'ok', detail: 'Chrome 130' },
        egress: { status: 'ok', detail: 'exit IP in JP', ip: '1.2.3.4', country: 'JP' },
        tripcom: { status: 'skip', detail: 'skipped — pass --hotel to test' },
      },
      {
        market: 'NL',
        endpoint: 'http://127.0.0.1:9223',
        proxy: 'http://nl-exit.example:8000',
        chrome: { status: 'ok', detail: 'Chrome 130' },
        egress: { status: 'warn', detail: 'exit IP in JP, expected NL', ip: '1.2.3.4', country: 'JP' },
        tripcom: { status: 'skip', detail: 'skipped — pass --hotel to test' },
      },
    ],
  };

  it('warns when every market shares one exit IP', () => {
    const text = formatReport(report);
    expect(text).toContain('すべての市場が同じIP（JP）から出ています');
    expect(text).toContain('http://nl-exit.example:8000');
    expect(text).toContain('✓ 比較を実行できる状態です。');
  });

  it('does not warn when the markets exit from different countries', () => {
    const text = formatReport({ ...report, distinctCountries: ['JP', 'NL'] });
    expect(text).not.toContain('すべての市場が同じIP');
  });
});

describe('API token', () => {
  const app = buildServer({ fixturesDir: FIXTURES, apiToken: 'secret-token' });
  afterAll(() => app.close());

  it('rejects an API call without the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/markets' });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/markets',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('leaves the screen and health check open so the page still loads', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

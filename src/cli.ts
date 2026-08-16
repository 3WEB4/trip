#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run cli -- "<trip.com url>" --markets JP,NL
 *   npm run cli -- "<trip.com url>" --fixtures tests/fixtures/sample
 *
 * The comparison JSON goes to stdout; logs go to stderr, so the output can be
 * piped straight into jq.
 */

import { runComparison } from './pipeline.js';
import { listMarkets, DEFAULT_MARKETS } from './markets/markets.js';
import { TripUrlParseError } from './url/parseTripUrl.js';
import { setLogLevel, type LogLevel } from './util/logger.js';

interface CliArgs {
  url: string | null;
  markets: string[];
  currency: string;
  samples: number;
  delayMs: number;
  fixturesDir?: string;
  cdpUrl?: string;
  keepPageOpen: boolean;
  logLevel: LogLevel;
  pretty: boolean;
  help: boolean;
}

const USAGE = `
trip-compare — compare a Trip.com hotel rate across country/region markets

Usage:
  trip-compare <trip.com-url> [options]

Options:
  --markets <list>     Comma separated market codes (default: ${DEFAULT_MARKETS.join(',')})
  --currency <code>    Display currency for every market (default: JPY)
  --samples <n>        Samples per market; the median is reported (default: 1)
  --delay <ms>         Pause between samples (default: 1500)
  --fixtures <dir>     Replay saved responses from <dir>/<MARKET>.json instead of Chrome
  --cdp <url>          Chrome DevTools endpoint (default: $CHROME_CDP_URL or http://127.0.0.1:9222)
  --keep-open          Leave the market pages open (to solve a CAPTCHA by hand)
  --log-level <level>  debug | info | warn | error (default: info)
  --pretty             Indent the JSON output
  --list-markets       Print the known markets and exit
  -h, --help           Show this help

Chrome must already be running with remote debugging enabled, e.g.
  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.trip-chrome"
A freshly launched headless Chrome is rejected by Trip.com with HTTP 430.
`.trimStart();

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: null,
    markets: [...DEFAULT_MARKETS],
    currency: 'JPY',
    samples: 1,
    delayMs: 1_500,
    keepPageOpen: false,
    logLevel: 'info',
    pretty: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--markets':
        args.markets = next()
          .split(',')
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean);
        break;
      case '--currency':
        args.currency = next().toUpperCase();
        break;
      case '--samples':
        args.samples = Math.max(1, Number.parseInt(next(), 10) || 1);
        break;
      case '--delay':
        args.delayMs = Math.max(0, Number.parseInt(next(), 10) || 0);
        break;
      case '--fixtures':
        args.fixturesDir = next();
        break;
      case '--cdp':
        args.cdpUrl = next();
        break;
      case '--keep-open':
        args.keepPageOpen = true;
        break;
      case '--log-level':
        args.logLevel = next() as LogLevel;
        break;
      case '--pretty':
        args.pretty = true;
        break;
      case '--list-markets':
        process.stdout.write(
          `${listMarkets()
            .map((market) => `${market.code}\t${market.origin}\t${market.locale}\t${market.defaultCurrency}`)
            .join('\n')}\n`,
        );
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        args.url = arg;
    }
  }
  return args;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help || !args.url) {
    process.stdout.write(USAGE);
    return args.help ? 0 : 2;
  }

  setLogLevel(args.logLevel);

  try {
    const result = await runComparison(args.url, {
      markets: args.markets,
      targetCurrency: args.currency,
      samples: args.samples,
      delayMs: args.delayMs,
      ...(args.fixturesDir ? { fixturesDir: args.fixturesDir } : {}),
      cdp: {
        ...(args.cdpUrl ? { endpointUrl: args.cdpUrl } : {}),
        keepPageOpen: args.keepPageOpen,
      },
    });

    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);

    // Exit non-zero when the run produced no usable comparison, so scripts and
    // job runners can tell "JP is cheapest" from "we got blocked".
    if (result.prices.length === 0) return 1;
    if (result.failures.some((failure) => failure.manualActionRequired)) return 3;
    return 0;
  } catch (error) {
    if (error instanceof TripUrlParseError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  },
);

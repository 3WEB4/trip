#!/usr/bin/env node
/**
 * Starts one real Chrome per market.
 *
 *   node scripts/launch-chrome.mjs --markets JP,NL
 *   node scripts/launch-chrome.mjs --markets JP,NL --base-port 9222
 *
 * Each market gets its own profile directory and debugging port, and — when a
 * proxy is configured for it — its own exit IP. A proxy can only be given to
 * Chrome at launch, which is why this script exists rather than the worker
 * setting one over CDP.
 *
 * The browsers are deliberately NOT headless: a freshly launched headless
 * Chrome is answered with HTTP 430 by Trip.com. Leave these windows open while
 * comparisons run, and sign in / solve any CAPTCHA in them by hand.
 *
 * Prints the exact TRIP_MARKET_* variables to feed the API or CLI.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function parseArgs(argv) {
  const args = { markets: ['JP', 'NL'], basePort: 9222, profileRoot: join(homedir(), '.trip-chrome') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--markets') args.markets = argv[++index].split(',').map((code) => code.trim().toUpperCase());
    else if (arg === '--base-port') args.basePort = Number.parseInt(argv[++index], 10);
    else if (arg === '--profile-root') args.profileRoot = argv[++index];
    else if (arg === '-h' || arg === '--help') args.help = true;
  }
  return args;
}

function chromeBinary() {
  // `spawn` fails lazily, so probe the paths up front instead.
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** Credentials must never reach the console. */
function safeProxy(proxy) {
  if (!proxy) return null;
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(unparsable proxy)';
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    'Usage: node scripts/launch-chrome.mjs [--markets JP,NL] [--base-port 9222] [--profile-root <dir>]\n\n' +
      'Set TRIP_MARKET_<CODE>_PROXY before running to give a market its own exit IP.',
  );
  process.exit(0);
}

const binary = chromeBinary();
if (!binary) {
  console.error(
    'Chrome not found. Set CHROME_PATH to the executable, e.g.\n' +
      '  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/launch-chrome.mjs',
  );
  process.exit(1);
}

const children = [];
const envLines = [];

args.markets.forEach((market, index) => {
  const port = args.basePort + index;
  const profile = join(args.profileRoot, market);
  mkdirSync(profile, { recursive: true });

  const proxy = process.env[`TRIP_MARKET_${market}_PROXY`];
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (proxy) chromeArgs.push(`--proxy-server=${proxy}`);

  const child = spawn(binary, chromeArgs, { stdio: 'ignore', detached: false });
  child.on('exit', (code) => console.log(`[${market}] Chrome exited (${code})`));
  children.push(child);

  console.log(`[${market}] port ${port}  profile ${profile}${proxy ? `  proxy ${safeProxy(proxy)}` : '  (no proxy — local IP)'}`);
  envLines.push(`TRIP_MARKET_${market}_CDP=http://127.0.0.1:${port}`);
});

console.log(
  [
    '',
    'Chrome を各市場ぶん起動しました。ウィンドウは開いたままにしてください。',
    'それぞれで一度 trip.com を開き、通常の閲覧状態にしておくと安定します。',
    '',
    '別のターミナルで次を設定してから実行してください:',
    '',
    ...envLines.map((line) => `  export ${line}`),
    '',
    '  npm run doctor -- --markets ' + args.markets.join(','),
    '',
  ].join('\n'),
);

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

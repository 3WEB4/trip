#!/usr/bin/env node
/**
 * Puts the comparison screen on a public URL, in one command.
 *
 *   npm run share            live prices (needs the market Chromes running)
 *   npm run share -- --demo  saved sample data, no Chrome needed
 *
 * Starts the API locally and opens a Cloudflare quick tunnel to it, then
 * prints the https:// address to open on a phone.
 *
 * A public URL means anyone who has it can spend your browser and your IP, so
 * an access token is generated automatically unless you set API_TOKEN. The
 * printed link carries it; the page remembers it after the first visit.
 *
 * Both processes stop together on Ctrl+C.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const INSTALL_HINT = `
cloudflared が見つかりませんでした。先にインストールしてください。

  macOS    brew install cloudflared
  Windows  winget install --id Cloudflare.cloudflared
  Linux    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

インストール後、もう一度 npm run share を実行してください。
`.trimStart();

function parseArgs(argv) {
  const args = { demo: false, port: Number.parseInt(process.env.PORT ?? '3000', 10) };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--demo') args.demo = true;
    else if (argv[index] === '--port') args.port = Number.parseInt(argv[++index], 10);
    else if (argv[index] === '-h' || argv[index] === '--help') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('Usage: npm run share -- [--demo] [--port 3000]');
  process.exit(0);
}

if (!existsSync(join(ROOT, 'node_modules'))) {
  console.error('先に npm install を実行してください。');
  process.exit(1);
}

// A public URL without a token would let anyone queue comparisons.
const token = process.env.API_TOKEN ?? randomBytes(16).toString('hex');
const generated = !process.env.API_TOKEN;

const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`\n1/2  サーバーを起動しています（${args.demo ? 'デモデータ' : '実データ'}, port ${args.port}）...`);

const server = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'api', 'server.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(args.port),
      HOST: '127.0.0.1',
      API_TOKEN: token,
      ...(args.demo ? { DEMO_FIXTURES: join(ROOT, 'tests', 'fixtures', 'tokyo-2848471') } : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
children.push(server);
server.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`\nサーバーが終了しました (${code})。`);
    shutdown(1);
  }
});

// Give Fastify a moment to bind before the tunnel points at it.
await new Promise((resolve) => setTimeout(resolve, 2500));

console.log('2/2  Cloudflare Tunnel を開いています...');

const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${args.port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

tunnel.on('error', (error) => {
  if (error.code === 'ENOENT') {
    console.error(`\n${INSTALL_HINT}`);
    shutdown(1);
    return;
  }
  console.error(`\ncloudflared の起動に失敗しました: ${error.message}`);
  shutdown(1);
});

children.push(tunnel);

let announced = false;
const watchForUrl = (chunk) => {
  const text = chunk.toString();
  const match = QUICK_TUNNEL_URL.exec(text);
  if (!match || announced) return;
  announced = true;

  const publicUrl = match[0];
  console.log(
    [
      '',
      '─'.repeat(60),
      '  スマホやPCのブラウザで、このURLを開いてください:',
      '',
      `  ${publicUrl}/?token=${token}`,
      '',
      generated
        ? '  ※ アクセストークンを自動生成しました。このURLを知っている人だけが使えます。'
        : '  ※ API_TOKEN の値を使用しています。',
      args.demo
        ? '  ※ デモモードです。表示される料金はサンプルで、実売価格ではありません。'
        : '  ※ 実データモードです。各市場の Chrome を起動したままにしてください。',
      '',
      '  終了するには Ctrl+C を押してください（URLは無効になります）。',
      '─'.repeat(60),
      '',
    ].join('\n'),
  );
};

tunnel.stdout.on('data', watchForUrl);
tunnel.stderr.on('data', watchForUrl);

tunnel.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`\ncloudflared が終了しました (${code})。`);
    shutdown(1);
  }
});

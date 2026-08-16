# Trip.com 国・地域別ホテル価格比較ツール

Trip.com のホテルURLを渡すと、同一ホテル・同一日程・同一客室・同一プランの料金を複数市場（JP / NL / FR / …）から取得し、JPY換算で安い順に返す。

Web画面・CLI・API の3つの入口があり、比較はジョブとして実行され進捗が見えます。市場ごとに別Chrome・別プロキシ（＝別の出口IP）を割り当てられます。DB保存は未実装（[未実装](#未実装)参照）。

## Web画面

```bash
npm install
npm run api                 # http://localhost:3000
```

URLを貼って市場を選ぶと、進捗を表示しながら比較し、安い順の表と各市場のTrip.comへの遷移リンクを出します。ブラウザを用意せず画面だけ確認する場合は、保存済みレスポンスで起動できます。

```bash
DEMO_FIXTURES=tests/fixtures/tokyo-2848471 npm run api
```

この場合は画面に「デモモード」と明示され、実売価格ではないことが分かるようになっています。

## CLI

```bash
npm install
npm run cli -- "https://jp.trip.com/hotels/detail/?hotelId=2848471&checkIn=2026-09-15&checkOut=2026-09-16&adult=2&crn=1" \
  --markets JP,NL --currency JPY --pretty
```

```json
{
  "hotel": { "hotelId": 2848471, "name": "Example Hotel Tokyo", "checkIn": "2026-09-15", "checkOut": "2026-09-16" },
  "matchedOn": { "physicalRoomId": 430120748, "roomId": 1599611286, "roomCode": "Q72FXT-Z-1",
                 "meal": "room-only", "cancellation": "free", "payment": "prepay", "taxIncluded": true },
  "prices": [
    { "market": "JP", "roomCode": "Q72FXT-Z-1", "currency": "JPY", "originalPrice": 44269, "jpyPrice": 44269, "availability": true },
    { "market": "NL", "roomCode": "Q72FXT-Z-1", "currency": "JPY", "originalPrice": 44750, "jpyPrice": 44750, "availability": true }
  ],
  "cheapestMarket": "JP",
  "savingVsJapan": 0,
  "matchQuality": { "confidence": "exact", "warnings": [] }
}
```

ブラウザなしで動作確認する場合は、保存済みレスポンスを再生する。

```bash
npm run cli -- "https://www.trip.com/hotels/detail/?hotelId=2848471&roomId=1599611286&checkIn=2026-09-15&checkOut=2026-09-16" \
  --fixtures tests/fixtures/tokyo-2848471 --pretty
```

## 本番で動かす（実データ取得）

内部APIは直接叩かない。新規ヘッドレスChromeは HTTP 430 になるため、**通常のChromeを先に起動しておき、CDPで接続**する。Cookie と `phantom-token` はそのプロファイル側に残り、本ツールは読み書き・保存しない。

手順は3つ。

```bash
# 1. 市場ごとにChromeを起動（プロファイルもポートも別。ウィンドウは開いたまま）
#    プロキシを使う場合は先に TRIP_MARKET_<CODE>_PROXY を設定しておく
npm run chrome -- --markets JP,NL

# 2. 起動時に表示された環境変数を設定し、準備できているか確認する
export TRIP_MARKET_JP_CDP=http://127.0.0.1:9222
export TRIP_MARKET_NL_CDP=http://127.0.0.1:9223
npm run doctor -- --markets JP,NL --hotel 2848471

# 3. 比較を実行
npm run cli -- "<Trip.comのURL>" --markets JP,NL --pretty
npm run api                                   # 画面から使う場合
```

`npm run doctor` は市場ごとに「Chromeに接続できるか」「どの国のIPから出ているか」「Trip.comが料金を返すか」を確認して、次のように表示する。**失敗の原因が実行前に分かる**ようにするためのコマンド。

```
JP  http://127.0.0.1:9222
  ✓ chrome    Chrome 141.0.7390.37
  ✓ exit IP   exit IP in JP
  ✓ trip.com  room list received, 12 bookable offers

NL  http://127.0.0.1:9223  via http://nl-exit.example:8000
  ✓ chrome    Chrome 141.0.7390.37
  ! exit IP   exit IP in JP, expected NL — prices will reflect JP, not NL
  ✗ trip.com  http-430: Room-list request returned HTTP 430 for NL
```

CAPTCHA や HTTP 430 は回避しない。`failures[].manualActionRequired: true` として返し、CLI は終了コード 3 を返す。`--keep-open` を付けるとページを開いたまま残すので、起動したChromeのウィンドウで手動でCAPTCHAを解いてから再実行できる。

### 市場別IP（プロキシ）

「どの国からアクセスすると安いか」を主張するには、ホスト・locale・region に加えて**IPも市場ごとに変える**必要がある。プロキシは Chrome の起動時にしか渡せない（CDP接続後には付けられない）ため、市場ごとに別のChromeを起動する形にしてある。

```bash
export TRIP_MARKET_NL_PROXY=http://user:pass@nl-exit.example:8000
export TRIP_MARKET_FR_PROXY=http://user:pass@fr-exit.example:8000
npm run chrome -- --markets JP,NL,FR
npm run doctor -- --markets JP,NL,FR      # 実際に別の国から出ているか確認
```

doctor は全市場が同じIPから出ている場合に警告する。プロキシ未設定のまま「NLの方が安い」と表示しても、それは**NLのIPから見た価格ではない**ため。認証情報はログにも画面にも出さず、ホストのみ表示する。

設定はファイルでもよい（`TRIP_MARKETS_FILE=./markets.local.json`、`.gitignore` 済み）。

```json
{
  "JP": { "cdpUrl": "http://127.0.0.1:9222", "expectedCountry": "JP" },
  "NL": { "cdpUrl": "http://127.0.0.1:9223", "proxy": "http://user:pass@nl-exit.example:8000", "expectedCountry": "NL" }
}
```

### 仕様変更が起きたとき

`SAVE_CAPTURES=./captures`（CLIは `--save-captures ./captures`）で、生のレスポンスを市場・時刻ごとに保存できる。保存されるのはレスポンス本文のみで、Cookieやトークンは含まれない。`captures/` は `.gitignore` 済み。保存したファイルを `<MARKET>.json` にリネームすれば、`--fixtures` でそのまま再現・修正できる。

### CLI オプション

| オプション | 内容 |
| --- | --- |
| `--markets JP,NL,FR` | 対象市場（既定 `JP,NL`） |
| `--currency JPY` | 全市場の表示通貨（既定 `JPY`） |
| `--samples 3` | 市場ごとの取得回数。中央値を返す |
| `--delay 1500` | 取得間隔 (ms) |
| `--fixtures <dir>` | `<dir>/<MARKET>.json` を再生（ブラウザ不要） |
| `--cdp <url>` | Chrome DevTools エンドポイント |
| `--keep-open` | 取得後もページを閉じない |
| `--log-level debug` | ログレベル（ログは stderr、結果は stdout） |
| `--list-markets` | 登録済み市場の一覧 |

終了コード: `0` 比較成功 / `1` 比較不能 / `2` 入力不正 / `3` 手動対応が必要（430・CAPTCHA等）。

## API

```
GET  /                              比較画面
POST /api/jobs                      比較をキューへ投入 → 202 とジョブID
GET  /api/jobs/:id                  状態・進捗・結果
GET  /api/jobs                      直近のジョブ
POST /api/hotel-price-comparisons   同期実行（curl・スクリプト向け）
GET  /api/markets                   市場一覧（demoMode フラグ付き）
GET  /health
```

```bash
curl -X POST localhost:3000/api/jobs -H 'content-type: application/json' \
  -d '{"tripUrl":"https://jp.trip.com/hotels/detail/?hotelId=2848471","markets":["JP","NL"]}'
# → {"id":"...","state":"queued","progress":{...}}
curl localhost:3000/api/jobs/<id>
```

比較は**常に1件ずつ直列実行**します。接続先Chromeが単一の共有資源であり、同一IPから複数の市場ページを並行して開くこと自体がブロックの原因になるためです。待ち行列が溢れた場合は `429 queue_full`。その他のエラーは `400 invalid_request / invalid_trip_url / unknown_market`、`502 no_comparable_offer`、`500 comparison_failed`。

ジョブは**インメモリ**で、既定30分で破棄されます。永続化が必要になった時点で `JobStore`（`create` / `get` / `list` の3メソッド）を BullMQ + Redis 実装に差し替えれば、ルート側は変更不要です。

### 環境変数

| 変数 | 内容 |
| --- | --- |
| `PORT` / `HOST` | 待受（既定 3000 / 0.0.0.0） |
| `DEMO_FIXTURES` | 指定すると全比較を保存済みレスポンスで実行（デモ用） |
| `ALLOW_CLIENT_FIXTURES` | `1` でリクエストの `fixturesDir` を許可。**公開サーバーでは有効にしないこと**（任意ディレクトリを読ませる指定になる） |
| `API_TOKEN` | 設定すると `/api/*` に `Authorization: Bearer <token>` を要求。画面は `?token=<値>` で一度開けば以降も動く |
| `CHROME_CDP_URL` | 既定のChrome DevToolsエンドポイント（既定 `http://127.0.0.1:9222`） |
| `TRIP_MARKET_<CODE>_CDP` | その市場専用のChrome |
| `TRIP_MARKET_<CODE>_PROXY` | その市場のChromeに渡す `--proxy-server` |
| `TRIP_MARKET_<CODE>_COUNTRY` | 期待する出口IPの国。doctor が照合する |
| `TRIP_MARKETS_FILE` | 上記をまとめたJSONファイル（環境変数の方が優先） |
| `SAVE_CAPTURES` | 生レスポンスの保存先ディレクトリ |
| `IP_LOOKUP_URL` | 出口IP確認先（既定 `https://ipinfo.io/json`） |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

**公開する場合は `API_TOKEN` を必ず設定すること。** 1回の比較は実ブラウザと実IPを消費するため、無認証で誰でもジョブを積める状態は避ける。未設定で `0.0.0.0` 待受にすると起動時に警告が出る。

## 構成

```
src/
  url/parseTripUrl.ts        1. URLから hotelId・日程・人数・roomId を抽出
  markets/markets.ts            市場定義（host / locale / region / 通貨 / 言語 / proxy枠）
  browser/cdpFetcher.ts      2-3. 通常Chrome へ CDP 接続し getHotelRoomList* の Response を捕捉
  browser/fixtureFetcher.ts     保存済みレスポンスの再生（オフライン検証・回帰用）
  extract/roomList.ts        4. Response → 販売可能な客室の正規化（★Trip.com依存はここだけ）
  match/matchOffers.ts       5. 同一商品の照合
  fx/rates.ts                8. 為替換算（ECB / 静的レート）
  compare/compareMarkets.ts  6. 取得・照合・換算・ランキング
  jobs/jobStore.ts           9. 比較ジョブ（直列実行・進捗・TTL）
  markets/overrides.ts      10. 市場ごとのChrome・プロキシ設定（環境変数 / JSON）
  doctor.ts                     実行前チェック（Chrome・出口IP・Trip.com疎通）
  api/server.ts                 Fastify API ＋ 画面配信
  cli.ts                        CLI
public/                      9. Web画面（ビルド不要の素のHTML/CSS/JS）
scripts/launch-chrome.mjs   10. 市場ごとにChromeを起動（プロファイル・ポート・プロキシ別）
```

Trip.com の仕様変更に備え、**生ペイロードを知っているのは `src/extract/roomList.ts` だけ**。ここはキー名の揺れ・入れ子の差異を吸収するため、固定パスではなくツリー走査で解釈する（`physicalRoomId` や `roomName` は親から継承）。壊れた場合もこのファイルだけを直せばよい。

## 同一商品の判定

客室名は市場ごとに翻訳されるため、**名称では照合しない**。

- ID: `physicalRoomId` / `roomId` / `roomCode` — 両市場が返した項目は必ず一致すること。最低1つは実際に一致している必要がある（両方 null の「沈黙による一致」は不成立）
- プラン条件: 食事・キャンセル・支払方法・税サービス料の包含。市場ごとの表記ゆれ（日英蘭仏泰韓中）は `room-only` / `free` / `prepay` などへ正規化してから比較
- 宿泊日・人数・室数はリクエスト側で全市場に同一値を渡す

一方の市場が項目を返さなかった場合は照合を続行しつつ `matchQuality.confidence: "probable"` と `warnings` で明示する。複数の候補が両市場に存在する場合は、**両市場が売っている最安プラン**を採用する。URLに `roomId` が含まれていればそれを優先する。

在庫切れ（`availability: false` / 残室数不足）のプランは比較対象から除外され、その市場は `unmatchedMarkets` に入る。

## 価格変動への対処

価格は在庫・時間帯・ログイン状態・ABテストで動く。`--samples N` で市場ごとに複数回取得し、**中央値**を `originalPrice` として返す。各取得時刻は `capturedAt[]` に全件残す。1回失敗しても他の回が成功していればその市場は生きる。

## 為替

既定は ECB レート（frankfurter.app、APIキー不要、1時間キャッシュ）。到達できない場合は静的レートにフォールバックする。まずは全市場の表示通貨を JPY に固定する運用のため、通常は換算不要（レート1）。市場が自国通貨でしか返さなかった場合のみ換算が効く。

## セキュリティ / 運用上の注意

- Cookie・トークン類はログにも保存物にも出さない（`src/util/redact.ts` を全ログ経路が通る）
- 実際に取得したレスポンスを `captures/` に置いても Git には入らない（`.gitignore` 済み）
- CAPTCHA・430 は回避しない。失敗として扱う
- 商用化前に利用規約・提携条件・自動アクセスの可否・送客方法を確認すること

## 開発

```bash
npm test          # vitest（71件）
npm run typecheck
npm run build
```

テストは保存済みレスポンス（`tests/fixtures/tokyo-2848471/`）で URL解析 → 抽出 → 照合 → 換算 → ランキング → ジョブAPI → 画面配信まで通しで検証しており、ブラウザもネットワークも不要。実データで挙動が変わったときは、そのレスポンスを `<MARKET>.json` として保存すれば同じ経路で再現できる。

## 公開して運用する場合

実データ取得には**通常のChromeが動くVMまたはコンテナ**が必要です（設計どおり）。ヘッドレスでは430になるため、サーバーレスやビルドだけのホスティングでは動きません。最低限の構成は次のとおりです。

1. VM上で `npm run chrome -- --markets JP,NL,...` を常駐（ウィンドウを閉じない。ヘッドレス不可）
2. `npm run doctor -- --markets ... --hotel <id>` が全部 ✓ になることを確認
3. 同じVMで `API_TOKEN=<値> npm run build && npm start`
4. リバースプロキシで公開（画面もAPIも同じポート）

比較は1件ずつ直列に実行される。同時利用者が増える場合は、市場ごとにVMを分けてIPも分離する。

公開前に、利用規約・提携条件・自動アクセスの可否・送客方法の確認が必要。`ALLOW_CLIENT_FIXTURES` は無効のままにすること。

## 未実装

| 項目 | 状況 |
| --- | --- |
| PostgreSQL への結果保存 | 未着手。`ComparisonResult` をそのまま格納できる形にはなっている |
| BullMQ + Redis | 未着手。`JobStore` を差し替えれば移行できる（複数プロセス化が必要になった時点で） |
| 会員価格・ログイン状態の扱い | 接続先Chromeのプロファイル状態に依存する。比較時は全市場で同条件（全部ログアウト、または全部ログイン）にすること |
| レート制限 | `API_TOKEN` とキュー上限（既定20件）のみ。IP単位の制限は未実装 |
| プロキシの死活監視 | doctor は実行時点の確認のみ。常時監視は未実装 |

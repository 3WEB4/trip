# Trip.com 国・地域別ホテル価格比較ツール

Trip.com のホテルURLを渡すと、同一ホテル・同一日程・同一客室・同一プランの料金を複数市場（JP / NL / FR / …）から取得し、JPY換算で安い順に返す。

現状は設計どおり **CLI と API まで**。Web画面・ジョブキュー・DB・市場別IP（プロキシ）はまだ入っていない（[未実装](#未実装mvp-9-10-以降)参照）。

## できること

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

## Chrome の準備（実データ取得時）

内部APIは直接叩かない。新規ヘッドレスChromeは HTTP 430 になるため、**通常のChromeを先に起動しておき、CDPで接続**する。Cookie と `phantom-token` はそのプロファイル側に残り、本ツールは読み書き・保存しない。

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.trip-chrome"
# 一度 Trip.com を開いて通常の閲覧状態にしておく
npm run cli -- "<URL>" --markets JP,NL          # 既定の接続先 http://127.0.0.1:9222
npm run cli -- "<URL>" --cdp http://127.0.0.1:9333
```

CAPTCHA や HTTP 430 は回避しない。`failures[].manualActionRequired: true` として返し、CLI は終了コード 3 を返す。`--keep-open` を付けるとページを開いたまま残すので、手動でCAPTCHAを解いてから再実行できる。

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

```bash
npm run api          # PORT=3000
```

```
POST /api/hotel-price-comparisons
{ "tripUrl": "...", "markets": ["JP","NL"], "targetCurrency": "JPY", "samples": 1 }

GET  /api/markets
GET  /health
```

比較は同期実行で、ブラウザが1つの共有資源のため**同時実行は1件に直列化**している。エラーは `400 invalid_request / invalid_trip_url / unknown_market`、`502 no_comparable_offer`、`500 comparison_failed`。

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
  api/server.ts                 Fastify API
  cli.ts                        CLI
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
npm test          # vitest（49件）
npm run typecheck
npm run build
```

テストは保存済みレスポンス（`tests/fixtures/tokyo-2848471/`）で URL解析 → 抽出 → 照合 → 換算 → ランキングまで通しで検証しており、ブラウザもネットワークも不要。実データで挙動が変わったときは、そのレスポンスを `<MARKET>.json` として保存すれば同じ経路で再現できる。

## 未実装（MVP 9-10 以降）

| 項目 | 状況 |
| --- | --- |
| Web画面・ジョブ進捗表示 | 未着手。`runComparison()` を BullMQ ジョブから呼ぶ想定 |
| BullMQ + Redis / PostgreSQL | 未着手。`compareMarkets()` の前段に置く（結果保存は `ComparisonResult` をそのまま格納できる形） |
| 市場別IP（プロキシ） | `MarketConfig.proxy` の枠のみ用意。「どの国からアクセスすると安いか」を主張するにはここが必須 |
| 会員価格・ログイン状態の扱い | 現状は接続先Chromeのプロファイル状態に依存する。比較時は全市場で同条件にすること |

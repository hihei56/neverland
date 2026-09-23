# Discord Account Link

本人が同意した場合にだけ、Discord OAuth2（Authorization Code Grant）で **ユーザーID・ユーザー名・メールアドレス・連携アカウント（connections）** を取得する Web アプリです。同意を前提にした連携ツールとして設計しています。

- 使うスコープは `identify email connections` だけです
- **Bot トークンは使いません。** 情報は、本人が発行したアクセストークンで本人のものだけを取得します（`/users/@me`, `/users/@me/connections`）
- 次の場合は **何も取得・保存しません**
  - 同意チェックを入れていない
  - Discord の認可画面でキャンセルした
  - 必要なスコープがそろっていない
  - 取得に失敗した
- 上の後半2つのようにトークンを受け取った後で中止した場合は、そのトークンを失効させます
- 依存パッケージは `dotenv` だけです（HTTP は `node:http`、暗号は `node:crypto`）

## 流れ

```
[同意画面 /]  利用目的・取得項目を表示し、チェックボックスで明示的に同意
     │ POST /link（CSRF トークン + agree=yes）
     ▼
[Discord 認可画面]  scope=identify email connections, state=<ランダム>, prompt=consent
     │ キャンセル → 何も取得せず終了（ログも残さない）
     ▼
[GET /callback]  state を検証（サーバー側で1回限り + ブラウザの Cookie と一致）
     │ code → token → スコープを確認 → /users/@me → /users/@me/connections
     ▼
暗号化して保存 + 同意ログ（仮名ID）
```

本人向けページ `/me` では、次の操作ができます。

- `identify` だけで本人確認する。このときのトークンはすぐに失効させ、保存しない
- 保存データの閲覧（開示）
- 同意の撤回
- 全削除

## セキュリティとプライバシー

| 項目 | 実装 |
|---|---|
| CSRF（OAuth） | `state` を 192bit のランダム値にしています。サーバー側で10分・1回限りとし、HttpOnly Cookie と照合します |
| CSRF（フォーム） | Cookie の値とフォームの値を比べる方式（ダブルサブミット）に、SameSite=Lax を組み合わせています |
| 保存時の暗号化 | トークン、email、connections を AES-256-GCM で暗号化します。鍵は `MASTER_KEY` から HKDF で用途別に作ります |
| 最小限の保存 | connections は type / id / name / verified / visibility だけ保存します。IP アドレスは保存しません |
| 同意ログ | `data/consent-log.jsonl` に追記だけを行います。ユーザーは HMAC による仮名IDで記録します。email やユーザー名は入れません |
| ログ | email・token・code・state・cookie を伏せて出力します |
| HTTP | CSP、X-Frame-Options、no-store を付けます。HTTPS のときは HSTS と `__Host-` 付きの Secure Cookie を使います |
| 保存期間 | `DATA_RETENTION_DAYS` を過ぎたデータは自動で削除し、トークンも失効させます |

## レート制限

- **Discord API**：`X-RateLimit-Remaining` と `Reset-After` を見て、バケットごとに待機します。429 のときは `retry_after` だけ待って再試行し、global の 429 ならすべてのリクエストを止めます。5xx とネットワークエラーは指数バックオフで再試行し、4xx は再試行しません
- **このアプリへのリクエスト**：IP ごとに 1 分あたり 120 リクエストまで、OAuth の開始は 1 分あたり 10 回までです

## 撤回と削除の違い

| 操作 | トークン | email / connections | ユーザーID | 同意ログ |
|---|---|---|---|---|
| 撤回（オプトアウト） | 失効させて破棄 | 消去 | 撤回記録として残す | `opted_out` を追記 |
| 削除 | 失効させて破棄 | 消去 | 消去 | `deleted` を追記（仮名ID） |
| 削除（`--purge-log`） | 失効させて破棄 | 消去 | 消去 | 同意ログも削除 |

本人が Discord の「認証済みアプリ」から連携を解除した場合、次に `refresh` したときに `invalid_grant` が返るので、撤回として処理します。

## セットアップ

```bash
npm install
cp .env.example .env
node src/cli.js gen-key      # 出力された値を MASTER_KEY に設定する
# APP_PURPOSE / OPERATOR_NAME / PRIVACY_CONTACT も設定する
npm start
npm test
```

Developer Portal の OAuth2 > Redirects に `${PUBLIC_BASE_URL}/callback` を登録してください。本番では HTTPS のリバースプロキシの後ろに置いてください。

## 運営者 CLI

```bash
node src/cli.js list                        # ユーザーID・状態・同意日時（email は表示しない）
node src/cli.js show <userId>               # 保存データを表示（閲覧したことを同意ログに記録）
node src/cli.js optout <userId>             # メールなどで撤回の依頼を受けたとき
node src/cli.js delete <userId> [--purge-log]
node src/cli.js refresh <userId>            # 保存済みトークンでデータを再取得
node src/cli.js purge-expired
node src/cli.js log <userId>                # 同意ログ
```

## 運用上の注意

- メールアドレスと連携アカウントは個人情報です。`APP_PURPOSE` には具体的な利用目的を書き、その目的以外には使わないでください。目的を変えるときはポリシーの版を上げ、改めて同意を取ってください
- Discord の Developer Terms と Developer Policy も守ってください。取得したデータの販売、第三者への提供、同意の範囲を超える利用はできません
- 同意を強制しないでください。連携しないと参加できない、特典を出して同意を促す、といった運用は避けてください
- `MASTER_KEY` と `data/` は厳重に管理してください。バックアップも暗号化したまま扱ってください

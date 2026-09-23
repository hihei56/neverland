# Guild Settings Backup Bot

自分が所有・管理する Discord サーバーの **設定** をバックアップ/復元する Bot です（discord.js v14 / JavaScript）。

- Discord 公式 Bot API と OAuth2 だけを使います（ユーザートークン・self-bot は使いません）
- `ALLOWED_GUILD_IDS` のギルドで、`BOT_OWNER_IDS` に含まれ、管理者権限を持つユーザーだけが操作できます
- メッセージ本文・メンバー一覧・DM・招待リンクは取得も保存もしません
- 復元は **dry-run が既定** です。既存のロールやチャンネルは変更も削除もしません

## 対象

| 対象 | 保存する | 保存しない |
|---|---|---|
| サーバー設定 | 名前、説明、アイコン/バナー/スプラッシュ、認証レベル、通知設定、AFK/システムチャンネル等 | 機能フラグ（参考情報として記録するだけ） |
| ロール | 名前、色、表示設定、権限、順序、アイコン | 連携ロール（記録はするが作成はしない） |
| カテゴリ/チャンネル | 種類、トピック、NSFW、低速モード、ボイス設定、フォーラムタグ等 | スレッド、メッセージ |
| 権限オーバーライド | ロール単位のもの | メンバー個人単位のもの |
| 絵文字/スタンプ | 画像、名前、使えるロール | 連携絵文字、Lottie形式スタンプ（復元できない） |
| Webhook | 名前、チャンネル、アバター | **token / URL** |

## ディレクトリ構成

```
backup-bot/
├── src/
│   ├── index.js                  エントリポイント（Guilds インテントのみ）
│   ├── config.js                 .env 読み込みと検証
│   ├── models/
│   │   ├── backup.js             バックアップのデータモデル（JSDoc）と検証
│   │   └── consent.js            同意記録のデータモデル
│   ├── storage/
│   │   ├── jsonFile.js           JSON の原子的書き込みと排他
│   │   └── backupRepository.js   data/backups/<guild>/<id>/ の管理
│   ├── backup/
│   │   ├── snapshot.js           Guild → スナップショット（export と差分計算の両方で使用）
│   │   └── exporter.js           export（画像は Discord CDN からだけ取得）
│   ├── restore/
│   │   ├── planner.js            差分から復元プランを作る（API を呼ばない純粋関数）
│   │   └── executor.js           プランを実行し、復元ログを保存
│   ├── consent/                  OAuth2 同意・暗号化・削除・再参加・荒らし対策取得
│   ├── web/server.js             同意ページ・プライバシーポリシー・OAuth コールバック
│   ├── commands/                 スラッシュコマンドの定義とハンドラ
│   ├── util/                     ロガー、キューとリトライ
│   └── scripts/registerCommands.js
├── test/                         node:test
└── data/                         （git 管理外）バックアップ・同意記録・復元ログ
    ├── backups/<guildId>/<backupId>/manifest.json, assets/
    ├── consents.json
    └── restore-logs/<guildId>/<timestamp>.json
```

## セットアップ

1. Developer Portal でアプリを作る。特権インテント（Server Members / Message Content）は **不要** なので OFF のままにする
2. Bot を招待する。招待 URL の scope は `bot applications.commands`。必要な権限は次のとおり
   - Manage Roles, Manage Channels, Manage Guild, Manage Expressions, Manage Webhooks, View Channels
   - 再参加機能を使う場合は Create Instant Invite も必要
   - Bot のロールは、復元で作るロールより **上** に置く
3. `.env.example` を `.env` にコピーして値を設定する
4. 次を実行する

```bash
npm install
npm run register   # /backup /members をギルドに登録（コマンドは管理者限定）
npm start
npm test
```

## 使い方

### export

```
/backup export label:定期バックアップ
/backup list
/backup info backup_id:20260923T041000Z-a1b2c3
/backup delete backup_id:… confirm:（同じIDをもう一度入力）
```

### restore（dry-run → 確認コードの順で実行）

```
/backup restore backup_id:20260923T041000Z-a1b2c3
  → 作る・再利用する・スキップする項目の一覧と、確認コード（例: 3F9A01C2）を表示。プランの JSON も添付される

/backup restore backup_id:20260923T041000Z-a1b2c3 execute:True confirm:3F9A01C2
  → ここで初めて書き込む
```

- 実行時はプランを作り直します。確認コードが dry-run のときと違えば（その間にサーバーが変わったなど）実行しません
- 同じ名前のものが既にあれば再利用し、**変更しません**。足りないものだけを作ります
- `@everyone` の権限は変更しません（違いがあれば警告だけ出します）
- サーバー設定は `guild_settings:True` を付けたときだけ更新します。アイコンなどは、今未設定の場合だけ入れます
- Bot 自身が持っていない権限は、ロールやオーバーライドから外し、そのことを警告として表示します
- コミュニティ機能が無いサーバーでは、アナウンスチャンネルはテキスト、ステージはボイスとして作ります
- Webhook は新しい URL で作られます。連携先の設定はやり直してください
- 新しいサーバーに復元するときは、そのサーバーの ID も `ALLOWED_GUILD_IDS` に追加してください

### メンバー再参加（任意・本人の同意が必要）

`OAUTH_ENABLED=true` にすると有効になります。

1. `/members consent-link` で同意ページを案内する。同意は任意であることを明記する
2. 希望した人が説明を読み、Discord の認可画面で `identify guilds.join` を許可する
3. サーバーを作り直したら、新しいサーバーで `/members rejoin source_guild:<元のID>` を実行する（dry-run）。表示された確認コードを付けて、もう一度実行する

再参加の実行では、結果を種類ごとに集計します（新規参加・参加済み・BAN済み・アカウント削除・参加上限・連携解除/失効・レート制限・その他失敗）。参加が失効・権限エラーで失敗した場合は1回だけトークンをリフレッシュして再試行します。サーバー側で招待が停止されている場合は全体を中断します。`VERIFY_ROLE_IDS` を設定していれば、参加後にそのロールを付与します。

**コマンドは管理者限定です。** 利用者向けのスラッシュコマンドは置いていません。

- 利用者の取り消し：Discord の「設定 > 認証済みアプリ」からこのアプリの連携を解除する。以後トークンは無効になり、次回処理時に破棄する（`invalid_grant` を検知して自動で失効扱いにする）
- 利用者の削除依頼：運営者（`PRIVACY_CONTACT`）に連絡してもらい、管理者が `/members forget user_id:<ID> confirm:<同じID>` で削除する
- プライバシーポリシーは Web の `/privacy` で公開する（`/members consent-link` の案内にも載る）

トークン・メール・連携アカウントは AES-256-GCM で暗号化して保存し、ログには残しません。IP は既定でハッシュのみ記録します。

### 荒らし対策の追加取得（任意・既定オフ）

`.env` で有効化すると、認証時に本人の OAuth 許可の範囲で以下も取得します（有効化した場合は `/privacy` とサーバー掲示で必ず周知してください）。

- `VERIFY_COLLECT_EMAIL` / `VERIFY_COLLECT_CONNECTIONS`：メール・連携アカウントを暗号化保存
- `VERIFY_LOG_IP`：認証時の IP を HMAC ハッシュで記録（同一 IP の複数アカウント検出用。生 IP は残さない）／`VERIFY_LOG_IP_RAW` で生 IP を暗号化保存
- `CONSENT_MODE=simple`：同意ページを RestoreCord 風のシンプル表示にする（参加先の限定・削除・暗号化・レート制限は維持）

## レート制限とエラー

- discord.js の REST 層が、ルートごとの 429 を待機します（`rateLimited` イベントもログに出します）
- `TaskQueue` で書き込みを 1 本ずつ流し、`QUEUE_INTERVAL_MS` の間隔を空けます
- 5xx・429・ネットワークエラーは、指数バックオフとジッターを付けて最大 4 回までリトライします。4xx（権限不足・上限など）はリトライしません
- ログは JSON Lines 形式で `logs/bot.log` に出し、エラーは `logs/error.log` にも出します。トークン類は伏せます
- 復元の結果（項目ごとの成功・失敗・スキップ）は `data/restore-logs/` に保存し、コマンドの返信にも添付します

'use strict';

// .env から設定を読み込み、起動時に検証する。
// トークン等の秘匿値はここ以外で process.env を直接読まない。

const path = require('node:path');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

function list(name) {
    return (process.env[name] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`環境変数 ${name} が未設定です (.env を確認してください)`);
    return v;
}

/** "guildId:roleId,guildId:roleId" → Map。任意設定なので空でも良い。 */
function pairMap(name) {
    const map = new Map();
    for (const pair of list(name)) {
        const [g, r] = pair.split(':').map((s) => s.trim());
        if (/^\d{17,20}$/.test(g) && /^\d{17,20}$/.test(r)) map.set(g, r);
    }
    return map;
}

function loadConfig() {
    const oauthEnabled = process.env.OAUTH_ENABLED === 'true';
    const config = {
        // backup: 設定バックアップ＋メンバー再参加（既定）。
        // link:   再参加なし。email/connections の収集のみ（guilds.join を要求しない）。
        mode: process.env.APP_MODE === 'link' ? 'link' : 'backup',
        token: required('DISCORD_TOKEN'),
        clientId: required('DISCORD_CLIENT_ID'),
        // Botを操作できるユーザー（あなた自身）。空だと誰も管理コマンドを実行できない。
        ownerIds: list('BOT_OWNER_IDS'),
        // Botが操作してよいギルド。ここに無いギルドでは管理コマンドを拒否する。
        allowedGuildIds: list('ALLOWED_GUILD_IDS'),
        dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
        logDir: path.resolve(ROOT, process.env.LOG_DIR || 'logs'),
        // 1リクエストごとの最小間隔(ms)。discord.js 自体も429を処理するが、バースト自体を避ける。
        queueIntervalMs: Number(process.env.QUEUE_INTERVAL_MS || 350),
        maxAssetBytes: Number(process.env.MAX_ASSET_BYTES || 10 * 1024 * 1024),

        oauth: {
            enabled: oauthEnabled,
            clientSecret: oauthEnabled ? required('DISCORD_CLIENT_SECRET') : null,
            publicBaseUrl: oauthEnabled ? required('PUBLIC_BASE_URL').replace(/\/$/, '') : null,
            httpPort: Number(process.env.HTTP_PORT || 3000),
            // true にするとトークン等を暗号化せず平文で保存する（管理者の明示的な選択・非推奨）。
            tokenPlaintext: process.env.TOKEN_PLAINTEXT === 'true',
            // AES-256-GCM 用の32バイト鍵（64桁のhex）。平文モードでは不要。
            encryptionKey: oauthEnabled && process.env.TOKEN_PLAINTEXT !== 'true' ? required('TOKEN_ENCRYPTION_KEY') : (process.env.TOKEN_ENCRYPTION_KEY || null),
            // リバースプロキシ配下のときだけ true。X-Forwarded-For を信用する（IP判定・レート制限用）。
            // false のまま公開すると XFF を偽装できるので、プロキシの後ろに置く場合のみ有効化する。
            trustProxy: process.env.TRUST_PROXY === 'true',
        },
        members: {
            // 再参加/認証時に付与するロール（任意）。"guildId:roleId,..." 形式。
            verifyRoleIds: pairMap('VERIFY_ROLE_IDS'),
            // 再参加1件ごとの待機(ms)。レート制限を避けるための間隔。
            joinDelayMs: Number(process.env.MEMBER_JOIN_DELAY_MS || 750),
        },
        // 荒らし対策として認証時に追加取得する情報（すべて既定 false、任意で有効化）。
        // email/connections は本人が OAuth 認可画面で許可した場合のみ取得できる。
        // 有効化する場合は /privacy policy とサーバー側の掲示で必ず周知すること。
        antiRaid: {
            collectEmail: process.env.VERIFY_COLLECT_EMAIL === 'true',
            collectConnections: process.env.VERIFY_COLLECT_CONNECTIONS === 'true',
            // IP は既定で HMAC ハッシュのみ記録（同一IP判定用、生IPは残さない）。
            logIp: process.env.VERIFY_LOG_IP === 'true',
            // 生IPまで保存する（VPN判定等が必要な場合のみ。取り扱い注意）。
            logIpRaw: process.env.VERIFY_LOG_IP_RAW === 'true',
        },
        privacy: {
            policyVersion: process.env.PRIVACY_POLICY_VERSION || '2026-09-23',
            contact: process.env.PRIVACY_CONTACT || '(未設定: PRIVACY_CONTACT を設定してください)',
            operatorName: process.env.PRIVACY_OPERATOR_NAME || 'サーバー管理者',
        },
    };

    if (config.ownerIds.length === 0) {
        throw new Error('BOT_OWNER_IDS が空です。自分のユーザーIDを設定してください');
    }
    if (config.allowedGuildIds.length === 0) {
        throw new Error('ALLOWED_GUILD_IDS が空です。対象ギルドIDを設定してください');
    }
    // 鍵が指定されている場合は形式を検証（平文モードで鍵未指定なら検証しない）。
    if (oauthEnabled && !config.oauth.tokenPlaintext && !/^[0-9a-f]{64}$/i.test(config.oauth.encryptionKey || '')) {
        throw new Error('TOKEN_ENCRYPTION_KEY は64桁のhex (32バイト) にしてください（暗号化しない場合は TOKEN_PLAINTEXT=true）');
    }
    return config;
}

module.exports = { loadConfig, ROOT };

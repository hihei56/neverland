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

function loadConfig() {
    const oauthEnabled = process.env.OAUTH_ENABLED === 'true';

    const config = {
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
            // AES-256-GCM 用の32バイト鍵（64桁のhex）。OAuthトークンは必ず暗号化して保存する。
            encryptionKey: oauthEnabled ? required('TOKEN_ENCRYPTION_KEY') : null,
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
    if (oauthEnabled && !/^[0-9a-f]{64}$/i.test(config.oauth.encryptionKey)) {
        throw new Error('TOKEN_ENCRYPTION_KEY は64桁のhex (32バイト) にしてください');
    }
    return config;
}

module.exports = { loadConfig, ROOT };

'use strict';

// .env を読み込んで検証する。秘匿値はここ以外で process.env から読まない。
// Bot トークンは使わない（このアプリは OAuth2 の本人トークンだけを扱う）。

const path = require('node:path');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`環境変数 ${name} が未設定です (.env を確認してください)`);
    return v;
}

function loadConfig(env = process.env) {
    const publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/$/, '');
    const masterKey = required('MASTER_KEY');
    if (!/^[0-9a-f]{64}$/i.test(masterKey)) throw new Error('MASTER_KEY は64桁のhex (32バイト) にしてください');

    const purpose = required('APP_PURPOSE');

    return {
        clientId: required('DISCORD_CLIENT_ID'),
        clientSecret: required('DISCORD_CLIENT_SECRET'),
        publicBaseUrl,
        redirectUri: `${publicBaseUrl}/callback`,
        secureCookies: publicBaseUrl.startsWith('https://'),
        port: Number(env.PORT || 3000),
        // リバースプロキシ配下のとき true にすると X-Forwarded-For を信頼する（流入レート制限用）
        trustProxy: env.TRUST_PROXY === 'true',
        masterKey,
        dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
        logDir: path.resolve(ROOT, env.LOG_DIR || 'logs'),
        retentionDays: Number(env.DATA_RETENTION_DAYS || 365),
        app: {
            name: env.APP_NAME || 'Discord アカウント連携',
            // 利用目的は必須。同意画面とプライバシーポリシーにそのまま表示する。
            purpose,
            operatorName: required('OPERATOR_NAME'),
            contact: required('PRIVACY_CONTACT'),
            policyVersion: env.PRIVACY_POLICY_VERSION || '2026-09-23',
        },
    };
}

module.exports = { loadConfig, ROOT };

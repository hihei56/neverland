'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const nodeCrypto = require('node:crypto');
const { buildContainer } = require('../src/container');
const { createApp } = require('../src/http/app');
const { DiscordApiError } = require('../src/discord/client');

const USER = '300000000000000003';
const EMAIL = 'alice@example.com';
const silent = { info() {}, warn() {}, error() {} };

function fakeDiscord({ scope = 'identify email connections' } = {}) {
    const calls = { revoked: [], me: 0, connections: 0 };
    return {
        calls,
        authorizeUrl: ({ state, scopes }) => `https://discord.com/oauth2/authorize?scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`,
        exchangeCode: async (code) => ({ access_token: `at-${code}`, refresh_token: `rt-${code}`, expires_in: 604800, scope: code === 'manage' ? 'identify' : scope }),
        refresh: async () => { throw new DiscordApiError(400, { error: 'invalid_grant' }, '/oauth2/token'); },
        revoke: async (token) => { calls.revoked.push(token); return null; },
        me: async () => { calls.me++; return { id: USER, username: 'alice', global_name: 'Alice', email: EMAIL, verified: true }; },
        myConnections: async () => { calls.connections++; return [{ type: 'github', id: 'gh1', name: 'alice-gh', verified: true, visibility: 1, access_token: 'SHOULD_NOT_STORE' }]; },
    };
}

async function setup(discordOpts) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acclink-'));
    const config = {
        publicBaseUrl: 'http://localhost', secureCookies: false, trustProxy: false,
        masterKey: nodeCrypto.randomBytes(32).toString('hex'), dataDir, retentionDays: 365,
        app: { name: 'Test', purpose: 'テスト用の目的', operatorName: 'op', contact: 'c', policyVersion: 'v1' },
    };
    const discord = fakeDiscord(discordOpts);
    const c = buildContainer(config, { logger: silent, discord });
    const server = http.createServer(createApp({ config, service: c.service, crypto: c.crypto, logger: silent }));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const jar = new Map();
    const req = async (method, p, form) => {
        const res = await fetch(base + p, {
            method,
            redirect: 'manual',
            headers: {
                cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
                ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            },
            body: form ? new URLSearchParams(form) : undefined,
        });
        for (const sc of res.headers.getSetCookie()) {
            const [kv] = sc.split(';');
            const [k, v] = kv.split('=');
            if (/Max-Age=0/.test(sc)) jar.delete(k); else jar.set(k, v);
        }
        return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    };
    const t = { ...c, discord, dataDir, req, jar, close: () => new Promise((r) => server.close(r)) };
    await req('GET', '/');
    t.csrf = decodeURIComponent(jar.get('csrf'));
    return t;
}

const readData = (dir) => {
    const f = path.join(dir, 'users.json');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const readLog = (dir) => {
    const f = path.join(dir, 'consent-log.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};

async function startLink(t) {
    const r = await t.req('POST', '/link', { csrf: t.csrf, agree: 'yes' });
    assert.equal(r.status, 303);
    return new URL(r.location).searchParams.get('state');
}

test('同意チェックなし・CSRF不一致では Discord へ進まず、何も保存しない', async () => {
    const t = await setup();
    try {
        assert.equal((await t.req('POST', '/link', { csrf: t.csrf })).status, 400);
        assert.equal((await t.req('POST', '/link', { csrf: 'wrong', agree: 'yes' })).status, 403);
        assert.equal(readData(t.dataDir), '');
        assert.equal(t.discord.calls.me, 0);
    } finally { await t.close(); }
});

test('認可画面でキャンセルした人からは一切取得せず、ログにも残さない', async () => {
    const t = await setup();
    try {
        const state = await startLink(t);
        const r = await t.req('GET', `/callback?error=access_denied&state=${state}`);
        assert.equal(r.status, 200);
        assert.match(r.text, /一切取得・保存していません/);
        assert.equal(t.discord.calls.me, 0);
        assert.equal(readData(t.dataDir), '');
        assert.deepEqual(readLog(t.dataDir), []);
    } finally { await t.close(); }
});

test('state 検証: 不一致・再利用・Cookie なしは拒否', async () => {
    const t = await setup();
    try {
        const state = await startLink(t);
        assert.equal((await t.req('GET', '/callback?code=x&state=forged')).status, 400);
        // 上の失敗で oauth_state Cookie は消えるので、正しい state でも別ブラウザ扱いで拒否
        assert.equal((await t.req('GET', `/callback?code=x&state=${state}`)).status, 400);
        assert.equal(t.discord.calls.me, 0);
    } finally { await t.close(); }
});

test('同意 → 取得・暗号化保存 → 閲覧 → 撤回 → 管理者による削除', async () => {
    const t = await setup();
    try {
        const state = await startLink(t);
        const cb = await t.req('GET', `/callback?code=c1&state=${state}`);
        assert.equal(cb.status, 200);
        assert.match(cb.text, /連携しました/);

        // 保存ファイルに email・トークン・connections の平文が無いこと
        const raw = readData(t.dataDir);
        assert.ok(raw.includes(USER));
        for (const secret of [EMAIL, 'at-c1', 'rt-c1', 'alice-gh', 'SHOULD_NOT_STORE']) assert.ok(!raw.includes(secret), secret);

        // 同意ログは仮名ID
        const log = readLog(t.dataDir);
        assert.equal(log.length, 1);
        assert.equal(log[0].event, 'consent_granted');
        assert.ok(!JSON.stringify(log).includes(USER));

        // 本人は /me で確認できる
        const me = await t.req('GET', '/me');
        assert.match(me.text, /alice@example\.com/);
        assert.match(me.text, /alice-gh/);

        // 撤回: トークン失効、email/connections 消去、userId だけ残る
        assert.equal((await t.req('POST', '/me/optout', { csrf: t.csrf })).status, 200);
        assert.ok(t.discord.calls.revoked.includes('rt-c1'));
        const after = await t.service.view(USER);
        assert.equal(after.status, 'opted_out');
        assert.equal(after.profile, null);
        assert.equal(after.hasToken, false);

        // 削除は管理者専用: Web からは削除できない
        assert.equal((await t.req('POST', '/me/delete', { csrf: t.csrf, confirm: 'yes' })).status, 404);
        assert.doesNotMatch((await t.req('GET', '/me')).text, /action="\/me\/delete"/);
        assert.notEqual(await t.service.view(USER), null);

        // 管理者（運営者 CLI と同じ経路）による削除
        assert.equal(await t.service.delete(USER), true);
        assert.equal(await t.service.view(USER), null);
        const finalLog = readLog(t.dataDir);
        assert.deepEqual(finalLog.map((e) => e.event), ['consent_granted', 'opted_out', 'deleted']);
        assert.equal(finalLog.at(-1).actor, 'operator');
    } finally { await t.close(); }
});

test('スコープが欠けていたら保存せず、トークンを失効させる', async () => {
    const t = await setup({ scope: 'identify' });
    try {
        const state = await startLink(t);
        const r = await t.req('GET', `/callback?code=c2&state=${state}`);
        assert.equal(r.status, 400);
        assert.equal(readData(t.dataDir), '');
        assert.ok(t.discord.calls.revoked.includes('at-c2'));
        assert.equal(t.discord.calls.me, 0);
    } finally { await t.close(); }
});

test('本人確認フロー: identify のみ、トークンは即失効し、未連携者のデータは作らない', async () => {
    const t = await setup();
    try {
        const r = await t.req('GET', '/me/login');
        const url = new URL(r.location);
        assert.equal(url.searchParams.get('scope'), 'identify');
        const cb = await t.req('GET', `/callback?code=manage&state=${url.searchParams.get('state')}`);
        assert.equal(cb.location, '/me');
        assert.ok(t.discord.calls.revoked.includes('at-manage'));
        assert.match((await t.req('GET', '/me')).text, /保存されているデータはありません/);
        assert.equal(readData(t.dataDir), '');
        assert.equal(t.discord.calls.connections, 0);
    } finally { await t.close(); }
});

test('refresh: 連携解除済み(invalid_grant)なら撤回として処理', async () => {
    const t = await setup();
    try {
        const state = await startLink(t);
        await t.req('GET', `/callback?code=c3&state=${state}`);
        // 期限切れに見せかける
        await t.service.users.patch(USER, (r) => {
            const tok = t.crypto.open(r.tokens);
            tok.expiresAt = new Date(0).toISOString();
            r.tokens = t.crypto.seal(tok);
        });
        const res = await t.service.refresh(USER);
        assert.equal(res.ok, false);
        assert.equal((await t.service.view(USER)).status, 'opted_out');
        assert.equal(readLog(t.dataDir).at(-1).event, 'token_invalid');
    } finally { await t.close(); }
});

test('purgeExpired: 保存期間を過ぎたレコードを削除', async () => {
    const t = await setup();
    try {
        const state = await startLink(t);
        await t.req('GET', `/callback?code=c4&state=${state}`);
        assert.equal(await t.service.purgeExpired(Date.now()), 0);
        assert.equal(await t.service.purgeExpired(Date.now() + 366 * 86_400_000), 1);
        assert.equal(await t.service.view(USER), null);
    } finally { await t.close(); }
});

test('CLI delete: --yes が無ければ削除しない', async () => {
    const t = await setup();
    try {
        const state = await startLink(t);
        await t.req('GET', `/callback?code=c5&state=${state}`);
        const { spawnSync } = require('node:child_process');
        const env = {
            ...process.env, DOTENV_PATH: '/nonexistent', PUBLIC_BASE_URL: 'http://localhost', MASTER_KEY: t.config.masterKey,
            APP_PURPOSE: 'p', OPERATOR_NAME: 'o', PRIVACY_CONTACT: 'c', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 's',
            DATA_DIR: t.dataDir, LOG_DIR: path.join(t.dataDir, 'logs'),
        };
        const cli = path.join(__dirname, '..', 'src', 'cli.js');
        const r = spawnSync(process.execPath, [cli, 'delete', USER], { env, encoding: 'utf8' });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /--yes/);
        assert.notEqual(await t.service.view(USER), null);
    } finally { await t.close(); }
});

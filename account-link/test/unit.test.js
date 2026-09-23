'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { createCrypto } = require('../src/crypto');
const { RateLimiter } = require('../src/discord/rateLimiter');
const { createDiscordClient } = require('../src/discord/client');
const { redact } = require('../src/logger');

const silent = { info() {}, warn() {}, error() {} };

test('crypto: 暗号化の往復・改ざん検出・署名の期限', () => {
    const c = createCrypto(nodeCrypto.randomBytes(32).toString('hex'));
    const sealed = c.seal({ email: 'a@example.com' });
    assert.ok(!JSON.stringify(sealed).includes('a@example.com'));
    assert.deepEqual(c.open(sealed), { email: 'a@example.com' });
    assert.throws(() => c.open({ ...sealed, tag: Buffer.alloc(16).toString('base64') }));

    const tok = c.sign({ uid: '1', exp: Date.now() + 1000 });
    assert.equal(c.verify(tok).uid, '1');
    assert.equal(c.verify(tok.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))), null);
    assert.equal(c.verify(c.sign({ uid: '1', exp: Date.now() - 1 })), null);
    assert.equal(c.pseudonym('1'), c.pseudonym('1'));
    assert.notEqual(c.pseudonym('1'), c.pseudonym('2'));
});

function res(status, body, headers = {}) {
    return new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('client: 429 の retry_after だけ待って再試行する', async () => {
    const waits = [];
    let t = 0;
    const limiter = new RateLimiter({ now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
    const responses = [res(429, { retry_after: 2.5, global: false }), res(200, { id: '1' })];
    let calls = 0;
    const client = createDiscordClient({
        clientId: 'c', clientSecret: 's', redirectUri: 'r', logger: silent, limiter,
        fetchImpl: async () => { calls++; return responses.shift(); },
    });
    assert.deepEqual(await client.me('tok'), { id: '1' });
    assert.equal(calls, 2);
    assert.ok(waits[0] >= 2500);
});

test('client: Remaining=0 なら Reset-After まで次のリクエストを待つ', async () => {
    const waits = [];
    let t = 0;
    const limiter = new RateLimiter({ now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
    const client = createDiscordClient({
        clientId: 'c', clientSecret: 's', redirectUri: 'r', logger: silent, limiter,
        fetchImpl: async () => res(200, [], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.5' }),
    });
    await client.myConnections('tok');
    assert.deepEqual(waits, []);
    await client.myConnections('tok');
    assert.deepEqual(waits, [1500]);
});

test('client: 4xx はリトライせず DiscordApiError', async () => {
    let calls = 0;
    const client = createDiscordClient({
        clientId: 'c', clientSecret: 's', redirectUri: 'r', logger: silent,
        fetchImpl: async () => { calls++; return res(401, { message: '401: Unauthorized' }); },
    });
    await assert.rejects(client.me('bad'), (e) => e.status === 401);
    assert.equal(calls, 1);
});

test('client: 認可URLに必要なパラメータが入る', () => {
    const client = createDiscordClient({ clientId: '123', clientSecret: 's', redirectUri: 'https://x/callback', logger: silent });
    const u = new URL(client.authorizeUrl({ state: 'st', scopes: ['identify', 'email', 'connections'] }));
    assert.equal(u.searchParams.get('scope'), 'identify email connections');
    assert.equal(u.searchParams.get('state'), 'st');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('prompt'), 'consent');
});

test('logger: email・トークン・state を伏せる', () => {
    const r = redact({ email: 'a@b', access_token: 'x', state: 's', route: '/me' });
    assert.deepEqual(r, { email: '***', access_token: '***', state: '***', route: '/me' });
});

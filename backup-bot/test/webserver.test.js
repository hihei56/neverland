'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWebServer } = require('../src/web/server');
const { ConsentService } = require('../src/consent/consentService');
const { createCipher } = require('../src/consent/crypto');

const G = '100000000000000001';
const silent = { info() {}, warn() {}, error() {} };

function makeConsent() {
    return new ConsentService({
        store: null, cipher: createCipher(crypto.randomBytes(32).toString('hex')),
        oauth: { authorizeUrl: () => 'https://discord.com/oauth2/authorize' },
        policyVersion: 'v1', allowedGuildIds: [G], logger: silent,
    });
}

async function startServer(trustProxy = false) {
    const config = {
        allowedGuildIds: [G],
        antiRaid: { collectEmail: false, collectConnections: false, logIp: false, logIpRaw: false },
        oauth: { publicBaseUrl: 'http://localhost', httpPort: 0, trustProxy },
        privacy: { policyVersion: 'v1', contact: 'c', operatorName: 'o' },
    };
    const web = createWebServer({ config, consent: makeConsent(), client: { guilds: { cache: new Map() } }, logger: silent });
    await web.start();
    web.base = `http://127.0.0.1:${web.port}`;
    return web;
}

test('OAuth開始のレート制限（15/分）で429を返す', async () => {
    const web = await startServer();
    try {
        let redirects = 0, got429 = false;
        for (let i = 0; i < 20; i++) {
            const r = await fetch(`${web.base}/oauth/start?guild=${G}`, { redirect: 'manual' });
            if (r.status === 302) redirects++;
            else if (r.status === 429) got429 = true;
        }
        assert.equal(redirects, 15, `許可は15件のはず (got ${redirects})`);
        assert.ok(got429, '16件目以降は429');
    } finally { await web.close(); }
});

test('全体レート制限が効く（/privacy 連打で429）', async () => {
    const web = await startServer();
    try {
        let ok = 0, got429 = false;
        for (let i = 0; i < 130; i++) {
            const r = await fetch(`${web.base}/privacy`);
            if (r.status === 200) ok++;
            else if (r.status === 429) got429 = true;
        }
        assert.equal(ok, 120, `許可は120件のはず (got ${ok})`);
        assert.ok(got429);
    } finally { await web.close(); }
});

test('TRUST_PROXY=false のとき X-Forwarded-For を信用しない（偽装で回避できない）', async () => {
    const web = await startServer(false);
    try {
        let got429 = false;
        // 毎回違う XFF を送るが、trustProxy=false なので同一 socket IP で数える
        for (let i = 0; i < 20; i++) {
            const r = await fetch(`${web.base}/oauth/start?guild=${G}`, {
                redirect: 'manual', headers: { 'x-forwarded-for': `10.0.0.${i}` },
            });
            if (r.status === 429) got429 = true;
        }
        assert.ok(got429, 'XFF偽装ではレート制限を回避できないべき');
    } finally { await web.close(); }
});

test('state 上限を超えると混雑エラー', () => {
    const consent = makeConsent();
    for (let i = 0; i < 20_000; i++) consent.states.set(`s${i}`, { guildId: G, expires: Date.now() + 600_000 });
    assert.throws(() => consent.startAuthorization(G), /混雑/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConsentService } = require('../src/consent/consentService');
const { ConsentStore } = require('../src/consent/consentStore');
const { createCipher } = require('../src/consent/crypto');
const { privacyPolicyText } = require('../src/consent/privacyPolicy');

const GID = '100000000000000001';
const silent = { info() {}, warn() {}, error() {} };

function fakeOAuth({ scope, email = 'a@example.com' } = {}) {
    return {
        authorizeUrl: (state, scopes) => `https://discord.com/oauth2/authorize?scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`,
        exchangeCode: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 604800, scope }),
        me: async () => ({ id: '300000000000000003', username: 'alice', email, verified: true }),
        connections: async () => [{ type: 'github', id: 'gh1', name: 'alice-gh', verified: true, visibility: 1 }],
        revoke: async () => {},
    };
}

function setup(antiRaid, oauthOpts) {
    const store = new ConsentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')));
    const cipher = createCipher(crypto.randomBytes(32).toString('hex'));
    const svc = new ConsentService({ store, cipher, oauth: fakeOAuth(oauthOpts), policyVersion: 'v1', allowedGuildIds: [GID], antiRaid, logger: silent });
    return { store, cipher, svc };
}

test('既定では email/connections/IP を要求も保存もしない', async () => {
    const { svc, store } = setup({}, { scope: 'identify guilds.join' });
    assert.deepEqual(svc.scopes(), ['identify', 'guilds.join']);
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    const rec = await store.get('300000000000000003', GID);
    assert.equal(rec.profile, null);
    const raw = fs.readFileSync(store.file, 'utf8');
    assert.ok(!raw.includes('203.0.113.9') && !raw.includes('a@example.com'));
});

test('email/connections 有効時: スコープに追加し、暗号化して保存する', async () => {
    const antiRaid = { collectEmail: true, collectConnections: true };
    const { svc, store, cipher } = setup(antiRaid, { scope: 'identify guilds.join email connections' });
    assert.deepEqual(svc.scopes(), ['identify', 'guilds.join', 'email', 'connections']);

    const url = new URL(svc.startAuthorization(GID));
    const state = url.searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });

    const raw = fs.readFileSync(store.file, 'utf8');
    assert.ok(!raw.includes('a@example.com'), 'email は平文で保存されない');
    assert.ok(!raw.includes('alice-gh'), 'connection 名は平文で保存されない');

    const rec = await store.get('300000000000000003', GID);
    const data = JSON.parse(cipher.decrypt(rec.profile.enc));
    assert.equal(data.email, 'a@example.com');
    assert.equal(data.connections[0].name, 'alice-gh');
});

test('IPは既定でハッシュのみ、生IPは保存しない', async () => {
    const { svc, store } = setup({ logIp: true }, { scope: 'identify guilds.join' });
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    const rec = await store.get('300000000000000003', GID);
    const raw = fs.readFileSync(store.file, 'utf8');
    assert.ok(rec.profile.ipHash && /^[0-9a-f]{32}$/.test(rec.profile.ipHash));
    assert.equal(rec.profile.ipRaw, undefined);
    assert.ok(!raw.includes('203.0.113.9'), '生IPは保存されない');
});

test('同一IPの複数アカウントを検出できる（ハッシュ一致）', async () => {
    const { svc } = setup({ logIp: true }, { scope: 'identify guilds.join' });
    const join = async (userId, ip) => {
        svc.oauth.me = async () => ({ id: userId, username: 'u', verified: true });
        const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
        await svc.completeAuthorization('code', state, { ip });
    };
    await join('400000000000000001', '198.51.100.1');
    await join('400000000000000002', '198.51.100.1');
    await join('400000000000000003', '198.51.100.9');
    const clusters = await svc.ipClusters(GID);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].sort(), ['400000000000000001', '400000000000000002']);
});

test('オプトアウトで email/connections/IP も破棄される', async () => {
    const { svc, store } = setup({ collectEmail: true, logIp: true }, { scope: 'identify guilds.join email' });
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    await svc.optOut('300000000000000003', GID);
    const rec = await store.get('300000000000000003', GID);
    assert.equal(rec.status, 'opted_out');
    assert.equal(rec.profile, null);
    assert.equal(rec.tokens, null);
});

test('プライバシーポリシー: 有効化した項目を必ず明記する', () => {
    const off = privacyPolicyText({ policyVersion: 'v1', contact: 'c', operatorName: 'o', antiRaid: {} });
    assert.ok(!off.includes('荒らし対策のため'));

    const on = privacyPolicyText({ policyVersion: 'v1', contact: 'c', operatorName: 'o', antiRaid: { collectEmail: true, collectConnections: true, logIp: true } });
    assert.match(on, /メールアドレス（scope: email/);
    assert.match(on, /連携している外部アカウント/);
    assert.match(on, /IPアドレスのハッシュ値/);
});

test('管理者による削除(deleteAll)で記録ごと消え、トークンは失効される', async () => {
    const revoked = [];
    const { svc, store } = setup({ collectEmail: true, logIp: true }, { scope: 'identify guilds.join email' });
    svc.oauth.revoke = async (t) => { revoked.push(t); };
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    assert.notEqual(await store.get('300000000000000003', GID), null);

    const removed = await svc.deleteAll('300000000000000003');
    assert.ok(removed > 0);
    assert.equal(await store.get('300000000000000003', GID), null);
    assert.ok(revoked.includes('rt')); // リフレッシュトークンを失効
});

test('プライバシーポリシーに廃止した /privacy コマンドを載せない', () => {
    const text = privacyPolicyText({ policyVersion: 'v1', contact: 'c', operatorName: 'o', antiRaid: {} });
    assert.ok(!text.includes('/privacy'));
    assert.match(text, /認証済みアプリ/);   // 連携解除の導線
    assert.match(text, /運営者/);           // 削除の依頼先
});

test('平文モード(TOKEN_PLAINTEXT)ではトークンをそのまま保存する', async () => {
    const store = new ConsentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')));
    const cipher = createCipher(null, { plaintext: true });
    const svc = new ConsentService({ store, cipher, oauth: fakeOAuth({ scope: 'identify guilds.join email' }), policyVersion: 'v1', allowedGuildIds: [GID], antiRaid: { collectEmail: true, logIp: true }, logger: silent });
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    const raw = fs.readFileSync(store.file, 'utf8');
    // 平文モードなので生の値が保存されている
    assert.ok(raw.includes('a@example.com'));
    const rec = await store.get('300000000000000003', GID);
    assert.equal(cipher.decrypt(rec.tokens.accessToken), 'at');
});

test('describe: 生トークンは含めず、メタ情報とprofileを返す', async () => {
    const { svc } = setup({ collectEmail: true, logIp: true }, { scope: 'identify guilds.join email' });
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    const [info] = await svc.describe('300000000000000003');
    assert.equal(info.hasToken, true);
    assert.equal(info.email, 'a@example.com');
    assert.ok(info.ipHash);
    assert.ok(!('accessToken' in info) && !('tokens' in info)); // 生トークンは含めない
});


test('completeAuthorization: 認証ログ用に username と ipHash を返す', async () => {
    const { svc } = setup({ logIp: true }, { scope: 'identify guilds.join' });
    const state = new URL(svc.startAuthorization(GID)).searchParams.get('state');
    const r = await svc.completeAuthorization('code', state, { ip: '203.0.113.9' });
    assert.equal(r.userId, '300000000000000003');
    assert.equal(r.guildId, GID);
    assert.equal(r.username, 'alice');
    assert.ok(/^[0-9a-f]{32}$/.test(r.ipHash), 'IPを記録する設定では ipHash を返す');

    // IP非記録の既定では ipHash は null
    const { svc: svc2 } = setup({}, { scope: 'identify guilds.join' });
    const st2 = new URL(svc2.startAuthorization(GID)).searchParams.get('state');
    const r2 = await svc2.completeAuthorization('code', st2, { ip: '203.0.113.9' });
    assert.equal(r2.ipHash, null);
});

test('grantVerifyRole: 認証直後に認証ロールを即付与する', async () => {
    const cipher = createCipher(null, { plaintext: true });
    const svc = new ConsentService({ store: null, cipher, oauth: { authorizeUrl: () => 'x' }, policyVersion: 'v1', allowedGuildIds: [GID], verifyRoleIds: new Map([[GID, '900000000000000009']]), logger: silent });
    const puts = [];
    const client = { rest: { put: async (route) => { puts.push(route); } } };
    const r = await svc.grantVerifyRole(client, GID, '300000000000000003');
    assert.equal(r.granted, true);
    assert.equal(r.roleId, '900000000000000009');
    assert.ok(puts[0].includes('/roles/900000000000000009'));
    // 未設定ギルドでは付与しない
    const svc2 = new ConsentService({ store: null, cipher, oauth: {}, policyVersion: 'v1', allowedGuildIds: [GID], logger: silent });
    assert.equal((await svc2.grantVerifyRole(client, GID, 'u')).granted, false);
});

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
const { OAuthError } = require('../src/consent/discordOAuth');
const { TaskQueue } = require('../src/util/queue');

const USER = '300000000000000003';
const SRC = '100000000000000001';
const silent = { info() {}, warn() {}, error() {} };

async function setup(oauth, { expired = true } = {}) {
    const store = new ConsentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'consent-')));
    const cipher = createCipher(crypto.randomBytes(32).toString('hex'));
    const svc = new ConsentService({ store, cipher, oauth, policyVersion: 'v1', allowedGuildIds: [SRC], logger: silent });
    await store.upsert({
        userId: USER, guildId: SRC, scopes: ['identify', 'guilds.join'], policyVersion: 'v1',
        consentedAt: 'x', updatedAt: 'x', status: 'active',
        tokens: {
            accessToken: cipher.encrypt('at-0'),
            refreshToken: cipher.encrypt('rt-0'),
            expiresAt: new Date(Date.now() + (expired ? -1000 : 7 * 86_400_000)).toISOString(),
        },
    }, 'granted');
    const joined = [];
    const rest = { put: async (_route, { body }) => { joined.push(body.access_token); return { user: { id: USER } }; } };
    const run = (target) => svc.rejoinMembers({ rest, queue: new TaskQueue({ intervalMs: 0, retries: 0 }), sourceGuildId: SRC, targetGuildId: target });
    return { svc, store, cipher, joined, run };
}

const rotatingOAuth = () => {
    const calls = [];
    return {
        calls,
        refresh: async (rt) => {
            calls.push(rt);
            await new Promise((r) => setTimeout(r, 20));
            if (rt !== 'rt-0') throw new OAuthError(400, { error: 'invalid_grant' });
            return { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 604800 };
        },
        revoke: async () => {},
    };
};

test('同時に2つ再参加しても更新は1回だけで、誤って無効化しない', async () => {
    const oauth = rotatingOAuth();
    const t = await setup(oauth);
    const [a, b] = await Promise.all([t.run('200000000000000001'), t.run('200000000000000002')]);
    assert.equal(oauth.calls.length, 1);
    assert.equal(a.added + b.added, 2);
    assert.equal(a.revoked + b.revoked, 0);
    assert.deepEqual(t.joined, ['at-1', 'at-1']);
});

test('更新後は新しいリフレッシュトークンが保存される（ローテーション）', async () => {
    const t = await setup(rotatingOAuth());
    await t.run('200000000000000001');
    const r = await t.store.get(USER, SRC);
    assert.equal(t.cipher.decrypt(r.tokens.refreshToken), 'rt-1');
    assert.equal(t.cipher.decrypt(r.tokens.accessToken), 'at-1');
    assert.equal(r.status, 'active');
});

test('別プロセスが先に更新していた場合は、そのトークンを使い無効化しない', async () => {
    let t;
    const oauth = {
        refresh: async () => {
            // Discord 側では別プロセスが先に更新済み → こちらは invalid_grant
            await t.store.setTokens(USER, SRC, {
                accessToken: t.cipher.encrypt('at-other'),
                refreshToken: t.cipher.encrypt('rt-other'),
                expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            });
            throw new OAuthError(400, { error: 'invalid_grant' });
        },
        revoke: async () => {},
    };
    t = await setup(oauth);
    const r = await t.run('200000000000000001');
    assert.equal(r.added, 1);
    assert.equal(r.revoked, 0);
    assert.deepEqual(t.joined, ['at-other']);
    assert.equal((await t.store.get(USER, SRC)).status, 'active');
});

test('本当に連携解除されていれば revoked にしてトークンを破棄', async () => {
    const oauth = { refresh: async () => { throw new OAuthError(400, { error: 'invalid_grant' }); }, revoke: async () => {} };
    const t = await setup(oauth);
    const r = await t.run('200000000000000001');
    assert.equal(r.revoked, 1);
    assert.deepEqual(t.joined, []);
    const rec = await t.store.get(USER, SRC);
    assert.equal(rec.status, 'revoked');
    assert.equal(rec.tokens, null);
});

test('期限に余裕があれば更新しない', async () => {
    const oauth = rotatingOAuth();
    const t = await setup(oauth, { expired: false });
    await t.run('200000000000000001');
    assert.equal(oauth.calls.length, 0);
    assert.deepEqual(t.joined, ['at-0']);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TaskQueue, withRetry, isRetryable } = require('../src/util/queue');
const { createCipher } = require('../src/consent/crypto');
const { ConsentStore } = require('../src/consent/consentStore');
const { BackupRepository } = require('../src/storage/backupRepository');
const { validateManifest, newBackupId, isBackupId } = require('../src/models/backup');
const { redact } = require('../src/util/logger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bkbot-'));

test('withRetry: 5xx はリトライ、4xx はリトライしない', async () => {
    let n = 0;
    const r = await withRetry(async () => {
        if (++n < 3) throw Object.assign(new Error('boom'), { status: 502 });
        return 'ok';
    }, { baseMs: 1 });
    assert.equal(r, 'ok');
    assert.equal(n, 3);

    let m = 0;
    await assert.rejects(withRetry(async () => {
        m++;
        throw Object.assign(new Error('forbidden'), { status: 403 });
    }, { baseMs: 1 }));
    assert.equal(m, 1);
    assert.equal(isRetryable(Object.assign(new Error('x'), { status: 429 })), true);
});

test('TaskQueue: 直列実行・間隔・失敗しても後続が動く', async () => {
    const q = new TaskQueue({ intervalMs: 20, retries: 0 });
    const order = [];
    const t0 = Date.now();
    const p1 = q.add('a', async () => order.push('a'));
    const p2 = q.add('b', async () => { throw new Error('fail'); });
    const p3 = q.add('c', async () => order.push('c'));
    await p1;
    await assert.rejects(p2);
    await p3;
    assert.deepEqual(order, ['a', 'c']);
    assert.ok(Date.now() - t0 >= 40);
});

test('暗号化: 往復でき、改ざんは検出される', () => {
    const c = createCipher(crypto.randomBytes(32).toString('hex'));
    const enc = c.encrypt('secret-token');
    assert.notEqual(enc.data, 'secret-token');
    assert.equal(c.decrypt(enc), 'secret-token');
    const bad = { ...enc, data: Buffer.from('xxxx').toString('base64') };
    assert.throws(() => c.decrypt(bad));
});

test('ConsentStore: オプトアウトでトークン破棄、削除で完全消去', async () => {
    const store = new ConsentStore(tmp());
    const rec = (userId, guildId) => ({
        userId, guildId, scopes: ['identify', 'guilds.join'], policyVersion: 'v1', consentedAt: 'now', updatedAt: 'now',
        status: 'active', tokens: { accessToken: {}, refreshToken: {}, expiresAt: 'x' },
    });
    await store.upsert(rec('u1', 'g1'), 'granted');
    await store.upsert(rec('u1', 'g2'), 'granted');
    await store.upsert(rec('u2', 'g1'), 'granted');
    assert.equal((await store.listActive('g1')).length, 2);

    assert.equal(await store.deactivate('u1', 'g1', 'opted_out', 'opted_out'), 1);
    const r = await store.get('u1', 'g1');
    assert.equal(r.status, 'opted_out');
    assert.equal(r.tokens, null);
    assert.equal((await store.listActive('g1')).length, 1);

    await store.deleteUser('u1');
    const db = await store.all();
    assert.ok(db.records.every((x) => x.userId !== 'u1'));
    assert.ok(db.events.every((x) => x.userId !== 'u1'));
    assert.equal(db.records.length, 1);
});

test('BackupRepository: partial→commit、アセットのハッシュ検証、一覧', async () => {
    const repo = new BackupRepository(tmp());
    const guildId = '100000000000000001';
    const id = newBackupId();
    assert.ok(isBackupId(id));
    const s = await repo.begin(guildId, id);
    const ref = await s.saveAsset('emoji-1', Buffer.from('png'), 'image/png');
    const manifest = {
        schemaVersion: 1, id, createdAt: new Date().toISOString(), createdBy: '1', label: 't',
        source: { guildId, guildName: 'g' }, guild: { icon: null, banner: null, splash: null },
        roles: [], categories: [], channels: [], stickers: [], webhooks: [],
        emojis: [{ id: '1', name: 'e', animated: false, roleIds: [], asset: ref }], warnings: [],
    };
    await s.commit(manifest);
    assert.equal((await repo.list(guildId)).length, 1);
    assert.equal(await repo.findGuildOf(id), guildId);
    const loaded = await repo.load(guildId, id);
    assert.equal((await repo.readAsset(guildId, id, loaded.emojis[0].asset)).toString(), 'png');
    await assert.rejects(repo.readAsset(guildId, id, { ...ref, sha256: 'bad' }));
});

test('validateManifest: Webhookの秘匿情報と不正なファイル名を拒否', () => {
    const base = {
        schemaVersion: 1, id: '20260923T000000Z-abcdef', source: { guildId: '100000000000000001' }, guild: {},
        roles: [], categories: [], channels: [], emojis: [], stickers: [], webhooks: [],
    };
    assert.deepEqual(validateManifest(base), []);
    assert.ok(validateManifest({ ...base, webhooks: [{ id: '1', name: 'w', channelId: '2', avatar: null, token: 'x' }] }).length);
    assert.ok(validateManifest({ ...base, emojis: [{ asset: { file: '../../etc/passwd' } }] }).length);
});

test('logger.redact: トークン類を伏せる', () => {
    const out = redact({ accessToken: 'abc', nested: { client_secret: 'x', ok: 1 } });
    assert.equal(out.accessToken, '***');
    assert.equal(out.nested.client_secret, '***');
    assert.equal(out.nested.ok, 1);
});

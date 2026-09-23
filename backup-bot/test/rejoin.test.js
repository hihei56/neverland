'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Routes } = require('discord.js');
const { ConsentService } = require('../src/consent/consentService');
const { ConsentStore } = require('../src/consent/consentStore');
const { createCipher } = require('../src/consent/crypto');
const { TaskQueue } = require('../src/util/queue');

const SRC = '100000000000000001';
const TGT = '200000000000000002';
const silent = { info() {}, warn() {}, error() {} };

function apiError(status, code) {
    return Object.assign(new Error(`HTTP ${status}`), { status, code });
}

async function setup({ oauth, verifyRoleIds } = {}) {
    const store = new ConsentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'rejoin-')));
    const cipher = createCipher(crypto.randomBytes(32).toString('hex'));
    const svc = new ConsentService({
        store, cipher, policyVersion: 'v1', allowedGuildIds: [SRC, TGT], logger: silent,
        oauth: oauth || { revoke: async () => {} }, verifyRoleIds: verifyRoleIds || new Map(),
    });
    const add = async (userId, { expiresInDays = 7 } = {}) => {
        await store.upsert({
            userId, guildId: SRC, scopes: ['identify', 'guilds.join'], policyVersion: 'v1',
            consentedAt: 'x', updatedAt: 'x', status: 'active',
            tokens: {
                accessToken: cipher.encrypt(`at-${userId}`), refreshToken: cipher.encrypt(`rt-${userId}`),
                expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
            },
        }, 'granted');
    };
    const run = (rest) => svc.rejoinMembers({ rest, queue: new TaskQueue({ intervalMs: 0, retries: 0 }), sourceGuildId: SRC, targetGuildId: TGT });
    return { store, cipher, svc, add, run };
}

test('失敗を種類ごとに分類する（実測コードに基づく）', async () => {
    const t = await setup();
    await t.add('400000000000000001'); // 201 added
    await t.add('400000000000000002'); // 204 already
    await t.add('400000000000000003'); // banned 40007
    await t.add('400000000000000004'); // account deleted 10013
    await t.add('400000000000000005'); // guild limit 30001
    await t.add('400000000000000006'); // user limited 340015
    const outcomes = {
        '400000000000000001': () => ({ user: { id: 'x' } }),
        '400000000000000002': () => null,
        '400000000000000003': () => { throw apiError(403, 40007); },
        '400000000000000004': () => { throw apiError(403, 10013); },
        '400000000000000005': () => { throw apiError(400, 30001); },
        '400000000000000006': () => { throw apiError(403, 340015); },
    };
    const rest = { put: async (route) => outcomes[route.split('/').pop()]() };
    const r = await t.run(rest);
    assert.equal(r.added, 1);
    assert.equal(r.alreadyMember, 1);
    assert.equal(r.banned, 1);
    assert.equal(r.accountDeleted, 1);
    assert.equal(r.guildLimit, 1);
    assert.equal(r.userLimited, 1);
    assert.equal(r.failed, 0);
    // アカウント制限(340015)はリフレッシュ再試行しない（無駄打ちしない）
    assert.equal((await t.store.get('400000000000000006', SRC)).status, 'active');
    // アカウント削除(10013)は失効扱いにして以後スキップ
    assert.equal((await t.store.get('400000000000000004', SRC)).status, 'revoked');
});

test('403(トークン失効)なら1回リフレッシュして再試行し成功する', async () => {
    let refreshed = 0;
    const oauth = { refresh: async () => { refreshed++; return { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 604800 }; }, revoke: async () => {} };
    const t = await setup({ oauth });
    await t.add('400000000000000001', { expiresInDays: 7 }); // まだ期限内→最初のトークンで試す
    let call = 0;
    const rest = { put: async (route, { body }) => {
        call++;
        if (call === 1) throw apiError(403, 0);       // 1回目: 失効扱い
        assert.equal(body.access_token, 'new-at');    // 2回目: リフレッシュ後
        return { user: { id: 'x' } };
    } };
    const r = await t.run(rest);
    assert.equal(refreshed, 1);
    assert.equal(r.added, 1);
    assert.equal(call, 2);
});

test('招待停止(400002)なら全体を中断する', async () => {
    const t = await setup();
    for (let i = 1; i <= 5; i++) await t.add(`40000000000000000${i}`);
    let calls = 0;
    const rest = { put: async () => { calls++; throw apiError(403, 400002); } };
    const r = await t.run(rest);
    assert.equal(r.aborted, 'invite_stopped');
    assert.equal(calls, 1); // 最初の1件で中断
});

test('40002 は中断コードに含めない（過剰中断しない）', async () => {
    const t = await setup();
    await t.add('400000000000000001');
    await t.add('400000000000000002');
    let calls = 0;
    const rest = { put: async () => { calls++; throw apiError(400, 40002); } };
    const r = await t.run(rest);
    assert.equal(r.aborted, null);
    assert.equal(calls, 2); // 中断せず全件処理
});

test('VERIFY_ROLE_IDS 設定時は参加後にロールを付与する', async () => {
    const t = await setup({ verifyRoleIds: new Map([[TGT, '900000000000000009']]) });
    await t.add('400000000000000001');
    const puts = [];
    const rest = { put: async (route) => {
        puts.push(route);
        return route.includes('/roles/') ? undefined : { user: { id: 'x' } };
    } };
    const r = await t.run(rest);
    assert.equal(r.added, 1);
    assert.equal(r.roleAssigned, 1);
    assert.ok(puts.some((p) => p === Routes.guildMemberRole(TGT, '400000000000000001', '900000000000000009')));
});

test('リフレッシュが invalid_grant なら revoked に数え、参加を試みない', async () => {
    const { OAuthError } = require('../src/consent/discordOAuth');
    const oauth = { refresh: async () => { throw new OAuthError(400, { error: 'invalid_grant' }); }, revoke: async () => {} };
    const t = await setup({ oauth });
    await t.add('400000000000000009', { expiresInDays: -1 }); // 期限切れ→リフレッシュ必須
    let joinCalls = 0;
    const r = await t.run({ put: async () => { joinCalls++; return { user: { id: 'x' } }; } });
    assert.equal(r.revoked, 1);
    assert.equal(r.added, 0);
    assert.equal(joinCalls, 0);
    assert.equal((await t.store.get('400000000000000009', SRC)).status, 'revoked');
});

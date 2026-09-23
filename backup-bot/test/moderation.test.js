'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { decide, matchNgWord, normalize } = require('../src/moderation/moderator');
const { ModerationStore } = require('../src/moderation/moderationStore');

const member = ({ roles = [], admin = false, manage = false } = {}) => ({
    roles: { cache: new Map(roles.map((r) => [r, {}])) },
    permissions: new PermissionsBitField(
        (admin ? PermissionFlagsBits.Administrator : 0n) | (manage ? PermissionFlagsBits.ManageMessages : 0n),
    ),
});
const base = { enabled: true, targetRoleIds: [], ngWords: ['ばか', 'spam'] };

test('normalize/matchNgWord: 全角・大小・空白を吸収して部分一致', () => {
    assert.equal(normalize('Ｓ Ｐ Ａ Ｍ'), 'spam');
    assert.equal(matchNgWord('これは ＳＰＡＭ です', ['spam']), 'spam');
    assert.equal(matchNgWord('普通の文章', ['spam']), null);
});

test('NGワードを含むと削除、含まないと none', () => {
    assert.equal(decide({ content: 'おまえばか', member: member() }, base).action, 'delete');
    assert.equal(decide({ content: 'こんにちは', member: member() }, base).action, 'none');
});

test('管理者・メッセージ管理権限は対象外', () => {
    assert.equal(decide({ content: 'ばか', member: member({ admin: true }) }, base).action, 'none');
    assert.equal(decide({ content: 'ばか', member: member({ manage: true }) }, base).action, 'none');
});

test('targetRoleIds 指定時はそのロール保持者のみ対象、空なら全員', () => {
    const s = { ...base, targetRoleIds: ['R1'] };
    assert.equal(decide({ content: 'ばか', member: member({ roles: ['R1'] }) }, s).action, 'delete');
    assert.equal(decide({ content: 'ばか', member: member({ roles: ['R2'] }) }, s).action, 'none');
    // 空 = 全員
    assert.equal(decide({ content: 'ばか', member: member({ roles: ['R2'] }) }, base).action, 'delete');
});

test('無効時は何もしない', () => {
    assert.equal(decide({ content: 'ばか', member: member() }, { ...base, enabled: false }).action, 'none');
});

test('ModerationStore: 既定は全員対象・有効、更新できる', async () => {
    const store = new ModerationStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mod-')));
    const d = await store.get('100000000000000001');
    assert.deepEqual([d.enabled, d.targetRoleIds, d.ngWords], [true, [], []]);
    await store.update('100000000000000001', (s) => { s.ngWords.push('x'); s.targetRoleIds.push('R1'); });
    const after = await store.get('100000000000000001');
    assert.deepEqual(after.targetRoleIds, ['R1']);
    assert.deepEqual(after.ngWords, ['x']);
});

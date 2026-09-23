'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { escalationAction, createFloodTracker, StrikeStore, ESCALATION } = require('../src/moderation/spamEnforcer');

test('escalationAction: 回数に応じて段階、上限超は kick', () => {
    assert.equal(escalationAction(1), 10);
    assert.equal(escalationAction(2), 60);
    assert.equal(escalationAction(5), 40320);
    assert.equal(escalationAction(6), 'kick');
    assert.equal(escalationAction(99), 'kick');
    assert.equal(ESCALATION.at(-1), 'kick');
});

test('createFloodTracker: 閾値2で連投判定', () => {
    const f = createFloodTracker({ windowMs: 4000, threshold: 2 });
    assert.equal(f.isFlooding('u'), false); // 1通目
    assert.equal(f.isFlooding('u'), true);  // 2通目（連投）
    assert.equal(f.isFlooding('v'), false); // 別ユーザーは独立
});

test('StrikeStore: 累積し、期限切れでリセット', async () => {
    const store = new StrikeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'strike-')), 50);
    assert.equal(await store.bump('u'), 1);
    assert.equal(await store.bump('u'), 2);
    assert.equal(await store.get('u'), 2);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await store.get('u'), 0);   // 期限切れ
    assert.equal(await store.bump('u'), 1);  // 新規カウント
    await store.reset('u');
    assert.equal(await store.get('u'), 0);
});

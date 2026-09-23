'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthLogStore } = require('../src/members/authLogStore');

const GID = '100000000000000001';
const CID = '200000000000000002';

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'authlog-'));
}

test('未設定なら null、set で保存し get で読める', async () => {
    const store = new AuthLogStore(tmp());
    assert.equal(await store.get(GID), null);
    await store.set(GID, CID);
    assert.equal(await store.get(GID), CID);
});

test('.env 既定値をフォールバックとして使う', async () => {
    const store = new AuthLogStore(tmp(), new Map([[GID, CID]]));
    assert.equal(await store.get(GID), CID, '未設定でも既定値を返す');
    assert.equal(await store.get('999999999999999999'), null);
});

test('clear は既定値も無効化する（コマンドの解除が優先）', async () => {
    const store = new AuthLogStore(tmp(), new Map([[GID, CID]]));
    await store.clear(GID);
    assert.equal(await store.get(GID), null, '解除後は既定値も無効');
});

test('コマンドの設定は既定値より優先される', async () => {
    const other = '300000000000000003';
    const store = new AuthLogStore(tmp(), new Map([[GID, CID]]));
    await store.set(GID, other);
    assert.equal(await store.get(GID), other);
});

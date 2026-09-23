'use strict';

// JSONファイルの原子的な読み書き（tmpに書いてからrename）。
// 同一プロセス内の書き込みはファイルごとに直列化する。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const locks = new Map();

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
    }
}

async function writeJsonAtomic(file, data, { mode = 0o600 } = {}) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
    await fsp.rename(tmp, file);
}

/**
 * ファイル単位の排他で read-modify-write を行う。
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @param {(data: T) => T | Promise<T>} mutate
 */
function updateJson(file, fallback, mutate) {
    const prev = locks.get(file) || Promise.resolve();
    const next = prev.then(async () => {
        const data = await readJson(file, fallback);
        const updated = await mutate(data);
        await writeJsonAtomic(file, updated);
        return updated;
    });
    locks.set(file, next.catch(() => {}));
    return next;
}

function ensureDirSync(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

module.exports = { readJson, writeJsonAtomic, updateJson, ensureDirSync };

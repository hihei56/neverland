'use strict';

// JSON の原子的書き込み + プロセス間ロック（サーバーと管理CLIが同時に書いても壊れないように）。

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
    }
}

async function writeJsonAtomic(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fsp.rename(tmp, file);
}

/** O_EXCL でロックファイルを作る。30秒以上古いロックは異常終了の残骸とみなして除去。 */
async function withFileLock(file, fn) {
    const lock = `${file}.lock`;
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let i = 0; ; i++) {
        try {
            const h = await fsp.open(lock, 'wx', 0o600);
            await h.close();
            break;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            const st = await fsp.stat(lock).catch(() => null);
            if (st && Date.now() - st.mtimeMs > 30_000) await fsp.rm(lock, { force: true });
            if (i > 200) throw new Error(`ロックを取得できません: ${lock}`);
            await sleep(25 + Math.random() * 25);
        }
    }
    try {
        return await fn();
    } finally {
        await fsp.rm(lock, { force: true });
    }
}

const chains = new Map();
/**
 * read-modify-write。同一プロセス内は Promise チェーン、プロセス間はロックファイルで排他。
 * mutate の戻り値が保存され、updateJson はその値を返す。
 */
function updateJson(file, fallback, mutate) {
    const prev = chains.get(file) || Promise.resolve();
    const next = prev.then(() =>
        withFileLock(file, async () => {
            const data = await readJson(file, fallback);
            const updated = await mutate(data);
            await writeJsonAtomic(file, updated);
            return updated;
        }),
    );
    chains.set(file, next.catch(() => {}));
    return next;
}

module.exports = { readJson, writeJsonAtomic, updateJson, withFileLock };

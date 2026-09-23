'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJsonAtomic } = require('./jsonFile');
const { isBackupId, validateManifest, SNOWFLAKE } = require('../models/backup');

/**
 * data/backups/<guildId>/<backupId>/ を扱うリポジトリ。
 * エクスポート中は <backupId>.partial に書き、完了時に rename して不完全なバックアップを残さない。
 */
class BackupRepository {
    constructor(dataDir) {
        this.root = path.join(dataDir, 'backups');
    }

    dir(guildId, backupId) {
        if (!SNOWFLAKE.test(guildId) || !isBackupId(backupId)) throw new Error('guildId または backupId が不正です');
        return path.join(this.root, guildId, backupId);
    }

    /** エクスポート用の書き込みセッションを開始する。 */
    async begin(guildId, backupId) {
        const finalDir = this.dir(guildId, backupId);
        const workDir = `${finalDir}.partial`;
        await fsp.mkdir(path.join(workDir, 'assets'), { recursive: true, mode: 0o700 });
        return {
            /** @returns {Promise<import('../models/backup').AssetRef>} */
            saveAsset: async (baseName, buffer, contentType) => {
                const ext = extFromContentType(contentType);
                const file = `${baseName}.${ext}`.replace(/[^\w.-]/g, '_');
                await fsp.writeFile(path.join(workDir, 'assets', file), buffer, { mode: 0o600 });
                return {
                    file,
                    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                    contentType,
                    bytes: buffer.length,
                };
            },
            commit: async (manifest) => {
                const errors = validateManifest(manifest);
                if (errors.length) throw new Error(`manifest 検証エラー: ${errors.join(', ')}`);
                await writeJsonAtomic(path.join(workDir, 'manifest.json'), manifest);
                await fsp.rename(workDir, finalDir);
                return finalDir;
            },
            abort: () => fsp.rm(workDir, { recursive: true, force: true }),
        };
    }

    /** @returns {Promise<import('../models/backup').BackupManifest>} */
    async load(guildId, backupId) {
        const manifest = await readJson(path.join(this.dir(guildId, backupId), 'manifest.json'), null);
        if (!manifest) throw new Error(`バックアップ ${backupId} が見つかりません`);
        const errors = validateManifest(manifest);
        if (errors.length) throw new Error(`バックアップが破損しています: ${errors.join(', ')}`);
        return manifest;
    }

    /** backupId だけ分かっている場合に、どのギルドのものか探す。 */
    async findGuildOf(backupId) {
        if (!isBackupId(backupId)) return null;
        for (const guildId of await this.#readdir(this.root)) {
            if (!SNOWFLAKE.test(guildId)) continue;
            const entries = await this.#readdir(path.join(this.root, guildId));
            if (entries.includes(backupId)) return guildId;
        }
        return null;
    }

    /** アセットを読み込み、ハッシュを検証して返す。 */
    async readAsset(guildId, backupId, ref) {
        if (!ref) return null;
        const buf = await fsp.readFile(path.join(this.dir(guildId, backupId), 'assets', path.basename(ref.file)));
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        if (hash !== ref.sha256) throw new Error(`asset ${ref.file} のハッシュが一致しません`);
        return buf;
    }

    async list(guildId) {
        const ids = (await this.#readdir(path.join(this.root, guildId))).filter(isBackupId).sort().reverse();
        const out = [];
        for (const id of ids) {
            const m = await readJson(path.join(this.root, guildId, id, 'manifest.json'), null);
            if (!m) continue;
            out.push({
                id,
                label: m.label,
                createdAt: m.createdAt,
                counts: {
                    roles: m.roles.length, categories: m.categories.length, channels: m.channels.length,
                    emojis: m.emojis.length, stickers: m.stickers.length, webhooks: m.webhooks.length,
                },
            });
        }
        return out;
    }

    async remove(guildId, backupId) {
        await fsp.rm(this.dir(guildId, backupId), { recursive: true, force: true });
    }

    async #readdir(dir) {
        try {
            return await fsp.readdir(dir);
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }
    }
}

function extFromContentType(ct) {
    return { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'application/json': 'json' }[ct] || 'bin';
}

module.exports = { BackupRepository };

'use strict';

const { snapshotGuild } = require('./snapshot');
const { SCHEMA_VERSION, newBackupId } = require('../models/backup');
const { withRetry } = require('../util/queue');

// Discord CDN 以外からはダウンロードしない
const ALLOWED_ASSET_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/**
 * CDN から画像を取得する（サイズ上限・タイムアウト・リトライ付き）。
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function downloadAsset(url, { maxBytes, logger }) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_ASSET_HOSTS.has(u.hostname)) throw new Error(`許可されていないasset URL: ${u.hostname}`);
    return withRetry(async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
            const err = new Error(`asset download failed: HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        const len = Number(res.headers.get('content-length') || 0);
        if (len > maxBytes) throw new Error(`asset が大きすぎます (${len} bytes)`);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > maxBytes) throw new Error(`asset が大きすぎます (${buffer.length} bytes)`);
        const contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
        return { buffer, contentType };
    }, { label: 'asset', logger });
}

/**
 * ギルド設定をエクスポートして保存する。
 * @param {Object} deps
 * @param {import('discord.js').Guild} deps.guild
 * @param {import('../storage/backupRepository').BackupRepository} deps.repo
 * @param {import('../util/queue').TaskQueue} deps.queue
 * @param {any} deps.logger
 * @param {number} deps.maxAssetBytes
 * @param {string} deps.userId
 * @param {string|null} [deps.label]
 * @returns {Promise<import('../models/backup').BackupManifest>}
 */
async function exportGuild({ guild, repo, queue, logger, maxAssetBytes, userId, label = null }) {
    const id = newBackupId();
    const session = await repo.begin(guild.id, id);
    const warnings = [];

    const assetSink = async (baseName, url) => {
        try {
            const { buffer, contentType } = await downloadAsset(url, { maxBytes: maxAssetBytes, logger });
            return await session.saveAsset(baseName, buffer, contentType);
        } catch (err) {
            warnings.push(`画像 ${baseName} を保存できませんでした: ${err.message}`);
            logger.warn('asset download failed', { guildId: guild.id, baseName, error: err });
            return null;
        }
    };

    try {
        const snap = await snapshotGuild(guild, {
            assetSink,
            call: (label_, fn) => queue.add(`export:${label_}`, fn),
            warnings,
        });

        /** @type {import('../models/backup').BackupManifest} */
        const manifest = {
            schemaVersion: SCHEMA_VERSION,
            id,
            createdAt: new Date().toISOString(),
            createdBy: userId,
            label,
            source: { guildId: guild.id, guildName: guild.name },
            ...snap,
            warnings: [...new Set(warnings)],
        };
        await session.commit(manifest);
        logger.info('export completed', { guildId: guild.id, backupId: id, userId, warnings: manifest.warnings.length });
        return manifest;
    } catch (err) {
        await session.abort().catch(() => {});
        logger.error('export failed', { guildId: guild.id, backupId: id, error: err });
        throw err;
    }
}

module.exports = { exportGuild, downloadAsset };

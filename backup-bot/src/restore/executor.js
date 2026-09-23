'use strict';

// 復元プランの実行器。プランの create / update だけを実行し、reuse は ID 対応表に使うのみ。
// 1件の失敗で全体を止めず、結果をすべて記録する（restore ログとして保存）。
// 既存リソースの編集・削除 API は呼ばない（guild.edit は guildSettings 指定時のみ）。

const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { snapshotGuild } = require('../backup/snapshot');
const { buildRestorePlan, diffGuildSettings } = require('./planner');
const { writeJsonAtomic } = require('../storage/jsonFile');

const REASON = 'Settings backup restore';

/**
 * 対象ギルドの現状を取得してプランを作る（dry-run と実行で共通）。
 */
async function planForGuild({ guild, manifest, queue, options }) {
    const current = await snapshotGuild(guild, { call: (l, fn) => queue.add(`plan:${l}`, fn) });
    const me = guild.members.me ?? (await queue.add('plan:me', () => guild.members.fetchMe()));
    return buildRestorePlan(
        manifest,
        {
            targetGuildId: guild.id,
            current,
            features: [...guild.features],
            premiumTier: guild.premiumTier,
            botPermissions: me.permissions.bitfield.toString(),
            currentAssets: { icon: Boolean(guild.icon), banner: Boolean(guild.banner), splash: Boolean(guild.splash) },
        },
        options,
    );
}

/**
 * @param {Object} deps
 * @param {import('discord.js').Guild} deps.guild
 * @param {import('../models/backup').BackupManifest} deps.manifest
 * @param {import('./planner').RestorePlan} deps.plan
 * @param {import('../storage/backupRepository').BackupRepository} deps.repo
 * @param {import('../util/queue').TaskQueue} deps.queue
 * @param {any} deps.logger
 * @param {string} deps.dataDir
 * @param {string} deps.userId
 * @param {{ guildSettings?: boolean }} deps.options
 * @param {(done: number, total: number) => void} [deps.onProgress]
 */
async function executeRestore({ guild, manifest, plan, repo, queue, logger, dataDir, userId, options, onProgress }) {
    const src = manifest.source.guildId;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const botPerms = me.permissions.bitfield;
    const isAdmin = (botPerms & PermissionFlagsBits.Administrator) !== 0n;
    const mask = (bits) => (isAdmin ? BigInt(bits) : BigInt(bits) & botPerms);

    const byId = (list) => new Map(list.map((x) => [x.id, x]));
    const snapRoles = byId(manifest.roles);
    const snapEmojis = byId(manifest.emojis);
    const snapStickers = byId(manifest.stickers);
    const snapCategories = byId(manifest.categories);
    const snapChannels = byId(manifest.channels);
    const snapWebhooks = byId(manifest.webhooks);

    // スナップショットID -> 対象ギルドID
    const roleMap = new Map([[src, guild.id]]); // @everyone
    const channelMap = new Map();
    const emojiMap = new Map();
    for (const a of plan.actions) {
        if (a.op !== 'reuse') continue;
        if (a.entity === 'role') roleMap.set(a.ref, a.targetId);
        if (a.entity === 'category' || a.entity === 'channel') channelMap.set(a.ref, a.targetId);
        if (a.entity === 'emoji') emojiMap.set(a.ref, a.targetId);
    }

    const asset = (ref) => repo.readAsset(src, manifest.id, ref);
    const mapOverwrites = (overwrites, where, notes) => {
        const out = [];
        for (const ow of overwrites) {
            const id = roleMap.get(ow.roleId);
            if (!id) {
                notes.push(`${where}: 対応するロールが無いオーバーライドを除外`);
                continue;
            }
            const allow = mask(ow.allow);
            const deny = mask(ow.deny);
            if (allow !== BigInt(ow.allow) || deny !== BigInt(ow.deny)) notes.push(`${where}: Botが持たない権限をオーバーライドから除外`);
            out.push({ id, type: 0, allow, deny });
        }
        return out;
    };

    const results = [];
    const work = plan.actions.filter((a) => a.op === 'create' || a.op === 'update');
    let done = 0;

    for (const action of work) {
        const notes = [];
        const label = `restore:${action.entity}:${action.name}`;
        try {
            let created;
            switch (action.entity) {
                case 'role': {
                    const r = snapRoles.get(action.ref);
                    const canIcon = guild.features.includes('ROLE_ICONS');
                    const icon = canIcon && r.icon ? await asset(r.icon) : null;
                    created = await queue.add(label, () => guild.roles.create({
                        name: r.name,
                        color: r.color,
                        hoist: r.hoist,
                        mentionable: r.mentionable,
                        permissions: mask(r.permissions),
                        ...(icon ? { icon } : {}),
                        ...(canIcon && r.unicodeEmoji ? { unicodeEmoji: r.unicodeEmoji } : {}),
                        reason: REASON,
                    }));
                    roleMap.set(r.id, created.id);
                    break;
                }
                case 'emoji': {
                    const e = snapEmojis.get(action.ref);
                    const roles = e.roleIds.map((id) => roleMap.get(id)).filter(Boolean);
                    const attachment = await asset(e.asset);
                    created = await queue.add(label, () => guild.emojis.create({ attachment, name: e.name, roles, reason: REASON }));
                    emojiMap.set(e.id, created.id);
                    break;
                }
                case 'sticker': {
                    const s = snapStickers.get(action.ref);
                    const file = await asset(s.asset);
                    created = await queue.add(label, () => guild.stickers.create({
                        file: { attachment: file, name: s.asset.file },
                        name: s.name,
                        tags: s.tags || '⭐',
                        description: s.description ?? '',
                        reason: REASON,
                    }));
                    break;
                }
                case 'category': {
                    const c = snapCategories.get(action.ref);
                    created = await queue.add(label, () => guild.channels.create({
                        name: c.name,
                        type: ChannelType.GuildCategory,
                        permissionOverwrites: mapOverwrites(c.overwrites, c.name, notes),
                        reason: REASON,
                    }));
                    channelMap.set(c.id, created.id);
                    break;
                }
                case 'channel': {
                    const ch = snapChannels.get(action.ref);
                    const opts = channelCreateOptions(ch, action.detail.type, {
                        guild,
                        parent: ch.parentId ? channelMap.get(ch.parentId) ?? null : null,
                        permissionOverwrites: mapOverwrites(ch.overwrites, ch.name, notes),
                        emojiMap,
                    });
                    if (ch.parentId && !opts.parent) notes.push('親カテゴリが無いためカテゴリ外に作成');
                    created = await queue.add(label, () => guild.channels.create(opts));
                    channelMap.set(ch.id, created.id);
                    break;
                }
                case 'webhook': {
                    const w = snapWebhooks.get(action.ref);
                    const channelId = channelMap.get(w.channelId);
                    const channel = channelId && (await queue.add(`${label}:ch`, () => guild.channels.fetch(channelId)));
                    if (!channel?.createWebhook) throw new Error('Webhookを作成できないチャンネルです');
                    const avatar = w.avatar ? await asset(w.avatar) : undefined;
                    const hook = await queue.add(label, () => channel.createWebhook({ name: w.name, avatar, reason: REASON }));
                    // 返ってくる token/url はログにも結果にも残さない
                    created = { id: hook.id };
                    break;
                }
                case 'guild': {
                    if (!options.guildSettings) throw new Error('guildSettings が無効です');
                    const current = await snapshotGuild(guild, { call: (l, fn) => queue.add(`guild:${l}`, fn) });
                    const changes = diffGuildSettings(
                        manifest.guild,
                        current.guild,
                        { icon: Boolean(guild.icon), banner: Boolean(guild.banner), splash: Boolean(guild.splash) },
                        new Set(guild.features),
                    );
                    const edit = {};
                    for (const [k, v] of Object.entries(changes)) {
                        if (k.endsWith('ChannelId')) {
                            const target = channelMap.get(v);
                            if (target) edit[k.replace(/Id$/, '')] = target;
                            else notes.push(`${k}: 対応チャンネルが無いためスキップ`);
                        } else if (k === 'icon' || k === 'banner' || k === 'splash') {
                            edit[k] = await asset(v);
                        } else {
                            edit[k] = v;
                        }
                    }
                    if (Object.keys(edit).length) await queue.add(label, () => guild.edit({ ...edit, reason: REASON }));
                    created = { id: guild.id };
                    break;
                }
                default:
                    throw new Error(`unknown entity ${action.entity}`);
            }
            results.push({ entity: action.entity, name: action.name, ref: action.ref, status: 'ok', targetId: created?.id, notes });
        } catch (err) {
            logger.error('restore action failed', { guildId: guild.id, entity: action.entity, name: action.name, error: err });
            results.push({
                entity: action.entity, name: action.name, ref: action.ref, status: 'failed', notes,
                error: `${err.code ?? err.status ?? ''} ${err.message}`.trim(),
            });
        }
        onProgress?.(++done, work.length);
    }

    const report = {
        backupId: manifest.id,
        sourceGuildId: src,
        targetGuildId: guild.id,
        executedBy: userId,
        executedAt: new Date().toISOString(),
        confirmCode: plan.confirmCode,
        options,
        ok: results.filter((r) => r.status === 'ok').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: plan.actions.filter((a) => a.op === 'skip').map((a) => ({ entity: a.entity, name: a.name, reason: a.reason })),
        results,
    };
    const file = path.join(dataDir, 'restore-logs', guild.id, `${report.executedAt.replace(/[:.]/g, '-')}.json`);
    await writeJsonAtomic(file, report);
    logger.info('restore completed', { guildId: guild.id, backupId: manifest.id, ok: report.ok, failed: report.failed, log: file });
    return { report, logFile: file };
}

/**
 * ChannelSnapshot → guild.channels.create のオプション。種別ごとに有効なものだけ渡す。
 */
function channelCreateOptions(ch, type, { guild, parent, permissionOverwrites, emojiMap }) {
    const opts = { name: ch.name, type, parent, permissionOverwrites, reason: REASON };
    const isText = type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;
    const isVoice = type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
    const isForum = type === ChannelType.GuildForum || type === ChannelType.GuildMedia;

    if (isText || isForum) {
        if (ch.topic) opts.topic = ch.topic;
        opts.nsfw = ch.nsfw;
        if (ch.defaultAutoArchiveDuration) opts.defaultAutoArchiveDuration = ch.defaultAutoArchiveDuration;
    }
    if ((isText && type === ChannelType.GuildText) || isForum || isVoice) {
        if (ch.rateLimitPerUser != null) opts.rateLimitPerUser = ch.rateLimitPerUser;
    }
    if (isVoice) {
        if (ch.bitrate) opts.bitrate = Math.min(ch.bitrate, guild.maximumBitrate ?? 96000);
        if (ch.userLimit != null) opts.userLimit = ch.userLimit;
        if (ch.rtcRegion) opts.rtcRegion = ch.rtcRegion;
        if (ch.videoQualityMode) opts.videoQualityMode = ch.videoQualityMode;
        if (type === ChannelType.GuildVoice) opts.nsfw = ch.nsfw;
    }
    if (isForum) {
        const mapEmoji = (id, name) => {
            if (id) {
                const target = emojiMap.get(id);
                return target ? { id: target, name: null } : null;
            }
            return name ? { id: null, name } : null;
        };
        if (ch.availableTags) {
            opts.availableTags = ch.availableTags.map((t) => {
                const emoji = mapEmoji(t.emojiId, t.emojiName);
                return { name: t.name, moderated: t.moderated, ...(emoji ? { emoji } : {}) };
            });
        }
        if (ch.defaultReactionEmoji) {
            const emoji = mapEmoji(ch.defaultReactionEmoji.emojiId, ch.defaultReactionEmoji.emojiName);
            if (emoji) opts.defaultReactionEmoji = emoji;
        }
        if (ch.defaultSortOrder != null) opts.defaultSortOrder = ch.defaultSortOrder;
        if (ch.defaultForumLayout != null && type === ChannelType.GuildForum) opts.defaultForumLayout = ch.defaultForumLayout;
        if (ch.defaultThreadRateLimitPerUser != null) opts.defaultThreadRateLimitPerUser = ch.defaultThreadRateLimitPerUser;
    }
    return opts;
}

module.exports = { planForGuild, executeRestore, channelCreateOptions };

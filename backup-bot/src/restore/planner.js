'use strict';

// 復元プランナー（純粋関数・API呼び出しなし）。
//
// 方針: 非破壊
//   - 既存のロール/チャンネル/絵文字等は「同名なら再利用」し、一切変更・削除しない。
//   - 足りないものだけ作成する。
//   - ギルド設定の変更は options.guildSettings=true の時だけ。アイコン等は未設定の場合のみ入れる。
//   - @everyone の権限は既存ロールなので変更しない（差分は警告として表示）。

const crypto = require('node:crypto');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const EMOJI_LIMITS = [50, 100, 150, 250];
const STICKER_LIMITS = [5, 15, 30, 60];
const MAX_ROLES = 250;
const MAX_CHANNELS = 500;
const STICKER_FORMAT_LOTTIE = 3;

/**
 * @typedef {'create'|'reuse'|'skip'|'update'} PlanOp
 * @typedef {'role'|'emoji'|'sticker'|'category'|'channel'|'webhook'|'guild'} PlanEntity
 *
 * @typedef {Object} PlanAction
 * @property {PlanOp} op
 * @property {PlanEntity} entity
 * @property {string|null} ref         スナップショット側のID
 * @property {string} name
 * @property {string} [targetId]       reuse 時の既存ID
 * @property {string} [reason]         skip の理由・注意事項
 * @property {Object} [detail]         create/update の付加情報
 *
 * @typedef {Object} RestorePlan
 * @property {string} backupId
 * @property {string} targetGuildId
 * @property {PlanAction[]} actions
 * @property {string[]} warnings
 * @property {Record<string, Record<PlanOp, number>>} summary
 * @property {string} confirmCode
 */

/**
 * @param {import('../models/backup').BackupManifest} manifest
 * @param {Object} ctx
 * @param {string} ctx.targetGuildId
 * @param {ReturnType<import('../backup/snapshot').snapshotGuild> extends Promise<infer T> ? T : never} ctx.current
 * @param {string[]} ctx.features
 * @param {number} ctx.premiumTier
 * @param {string} ctx.botPermissions               ギルド全体でのBotの権限ビット
 * @param {{ icon: boolean, banner: boolean, splash: boolean }} ctx.currentAssets
 * @param {{ guildSettings?: boolean }} [options]
 * @returns {RestorePlan}
 */
function buildRestorePlan(manifest, ctx, options = {}) {
    const { current, targetGuildId } = ctx;
    const sameGuild = manifest.source.guildId === targetGuildId;
    const features = new Set(ctx.features);
    const botPerms = BigInt(ctx.botPermissions);
    const isAdmin = (botPerms & PermissionFlagsBits.Administrator) !== 0n;
    /** @type {PlanAction[]} */
    const actions = [];
    const warnings = [];

    // ---- ロール --------------------------------------------------------
    // Discord は新規ロールを最下位(@everyone の直上)に作るので、
    // 上位ロールから順に作ると作成後の相対順序がスナップショットと一致する。
    const curRoles = current.roles.filter((r) => !r.isEveryone);
    const claimedRoles = new Set();
    let roleCount = current.roles.length;
    const snapRoles = [...manifest.roles].sort((a, b) => b.position - a.position);

    for (const r of snapRoles) {
        if (r.isEveryone) {
            const cur = current.roles.find((x) => x.isEveryone);
            if (cur && cur.permissions !== r.permissions) {
                warnings.push('@everyone の権限がバックアップと異なりますが、既存ロールのため変更しません');
            }
            continue;
        }
        const existing =
            (sameGuild && curRoles.find((x) => x.id === r.id && !claimedRoles.has(x.id))) ||
            curRoles.find((x) => x.name === r.name && x.managed === r.managed && !claimedRoles.has(x.id));
        if (existing) {
            claimedRoles.add(existing.id);
            actions.push({ op: 'reuse', entity: 'role', ref: r.id, name: r.name, targetId: existing.id });
            continue;
        }
        if (r.managed) {
            actions.push({ op: 'skip', entity: 'role', ref: r.id, name: r.name, reason: '連携/Botロールは作成できません（該当Botを招待すると自動作成されます）' });
            continue;
        }
        if (roleCount >= MAX_ROLES) {
            actions.push({ op: 'skip', entity: 'role', ref: r.id, name: r.name, reason: 'ロール数の上限' });
            continue;
        }
        roleCount++;
        const perms = BigInt(r.permissions);
        const masked = isAdmin ? perms : perms & botPerms;
        actions.push({
            op: 'create', entity: 'role', ref: r.id, name: r.name,
            ...(masked !== perms ? { reason: 'Botが持たない権限は付与できないため除外します' } : {}),
        });
    }

    // ---- 絵文字 --------------------------------------------------------
    const tier = Math.max(0, Math.min(3, ctx.premiumTier || 0));
    const emojiSlots = {
        static: EMOJI_LIMITS[tier] - current.emojis.filter((e) => !e.animated).length,
        animated: EMOJI_LIMITS[tier] - current.emojis.filter((e) => e.animated).length,
    };
    for (const e of manifest.emojis) {
        const existing = current.emojis.find((x) => (sameGuild && x.id === e.id) || x.name === e.name);
        if (existing) {
            actions.push({ op: 'reuse', entity: 'emoji', ref: e.id, name: e.name, targetId: existing.id });
        } else if (!e.asset) {
            actions.push({ op: 'skip', entity: 'emoji', ref: e.id, name: e.name, reason: '画像がバックアップにありません' });
        } else if (emojiSlots[e.animated ? 'animated' : 'static'] <= 0) {
            actions.push({ op: 'skip', entity: 'emoji', ref: e.id, name: e.name, reason: '絵文字枠の上限' });
        } else {
            emojiSlots[e.animated ? 'animated' : 'static']--;
            actions.push({ op: 'create', entity: 'emoji', ref: e.id, name: e.name });
        }
    }

    // ---- スタンプ ------------------------------------------------------
    let stickerSlots = STICKER_LIMITS[tier] - current.stickers.length;
    for (const s of manifest.stickers) {
        const existing = current.stickers.find((x) => (sameGuild && x.id === s.id) || x.name === s.name);
        if (existing) {
            actions.push({ op: 'reuse', entity: 'sticker', ref: s.id, name: s.name, targetId: existing.id });
        } else if (s.format === STICKER_FORMAT_LOTTIE) {
            actions.push({ op: 'skip', entity: 'sticker', ref: s.id, name: s.name, reason: 'Lottie形式は一般のBotからアップロードできません' });
        } else if (!s.asset) {
            actions.push({ op: 'skip', entity: 'sticker', ref: s.id, name: s.name, reason: '画像がバックアップにありません' });
        } else if (stickerSlots <= 0) {
            actions.push({ op: 'skip', entity: 'sticker', ref: s.id, name: s.name, reason: 'スタンプ枠の上限' });
        } else {
            stickerSlots--;
            actions.push({ op: 'create', entity: 'sticker', ref: s.id, name: s.name });
        }
    }

    // ---- カテゴリ ------------------------------------------------------
    let channelCount = current.categories.length + current.channels.length;
    /** snapshot category id -> target id（既存のみ。新規作成分は実行時に決まる） */
    const categoryTarget = new Map();
    const claimedChannels = new Set();
    for (const c of [...manifest.categories].sort((a, b) => a.position - b.position)) {
        const existing =
            (sameGuild && current.categories.find((x) => x.id === c.id)) ||
            current.categories.find((x) => x.name === c.name && !claimedChannels.has(x.id));
        if (existing) {
            claimedChannels.add(existing.id);
            categoryTarget.set(c.id, existing.id);
            actions.push({ op: 'reuse', entity: 'category', ref: c.id, name: c.name, targetId: existing.id });
        } else if (channelCount >= MAX_CHANNELS) {
            actions.push({ op: 'skip', entity: 'category', ref: c.id, name: c.name, reason: 'チャンネル数の上限' });
        } else {
            channelCount++;
            actions.push({ op: 'create', entity: 'category', ref: c.id, name: c.name });
        }
    }

    // ---- チャンネル ----------------------------------------------------
    const catPos = new Map(manifest.categories.map((c) => [c.id, c.position]));
    const snapChannels = [...manifest.channels].sort(
        (a, b) => (catPos.get(a.parentId) ?? -1) - (catPos.get(b.parentId) ?? -1) || a.position - b.position,
    );
    for (const ch of snapChannels) {
        const type = effectiveChannelType(ch.type, features);
        const parentTarget = ch.parentId ? categoryTarget.get(ch.parentId) ?? null : null;
        const parentIsNew = Boolean(ch.parentId) && !parentTarget;
        const existing =
            (sameGuild && current.channels.find((x) => x.id === ch.id)) ||
            (!parentIsNew &&
                current.channels.find(
                    (x) => x.name === ch.name && x.type === type && (x.parentId ?? null) === parentTarget && !claimedChannels.has(x.id),
                ));
        if (existing) {
            claimedChannels.add(existing.id);
            actions.push({ op: 'reuse', entity: 'channel', ref: ch.id, name: ch.name, targetId: existing.id });
            continue;
        }
        if (channelCount >= MAX_CHANNELS) {
            actions.push({ op: 'skip', entity: 'channel', ref: ch.id, name: ch.name, reason: 'チャンネル数の上限' });
            continue;
        }
        channelCount++;
        actions.push({
            op: 'create', entity: 'channel', ref: ch.id, name: ch.name,
            detail: { type },
            ...(type !== ch.type ? { reason: 'コミュニティ未有効のため種別を変更して作成します' } : {}),
        });
    }

    // ---- Webhook -------------------------------------------------------
    const channelActions = new Map(actions.filter((a) => a.entity === 'channel').map((a) => [a.ref, a]));
    for (const w of manifest.webhooks) {
        const chAction = channelActions.get(w.channelId);
        if (!chAction || chAction.op === 'skip') {
            actions.push({ op: 'skip', entity: 'webhook', ref: w.id, name: w.name, reason: '対象チャンネルが復元されません' });
            continue;
        }
        if (chAction.op === 'reuse') {
            const dup = current.webhooks.find((x) => x.channelId === chAction.targetId && x.name === w.name);
            if (dup) {
                actions.push({ op: 'reuse', entity: 'webhook', ref: w.id, name: w.name, targetId: dup.id });
                continue;
            }
        }
        actions.push({ op: 'create', entity: 'webhook', ref: w.id, name: w.name, reason: '新しいURLが発行されます。連携先は手動で再設定してください' });
    }

    // ---- ギルド設定 ----------------------------------------------------
    if (options.guildSettings) {
        const changes = diffGuildSettings(manifest.guild, current.guild, ctx.currentAssets, features);
        if (Object.keys(changes).length) {
            actions.push({ op: 'update', entity: 'guild', ref: null, name: manifest.guild.name, detail: { fields: Object.keys(changes).sort() } });
        }
    }

    if (!isAdmin) {
        const needed = ['ManageRoles', 'ManageChannels', 'ManageGuildExpressions', 'ManageWebhooks', 'ManageGuild'];
        const missing = needed.filter((p) => (botPerms & PermissionFlagsBits[p]) === 0n);
        if (missing.length) warnings.push(`Botに不足している権限: ${missing.join(', ')}`);
    }

    const summary = {};
    for (const a of actions) {
        summary[a.entity] ??= { create: 0, reuse: 0, skip: 0, update: 0 };
        summary[a.entity][a.op]++;
    }

    return {
        backupId: manifest.id,
        targetGuildId,
        actions,
        warnings,
        summary,
        confirmCode: confirmCodeFor(manifest.id, targetGuildId, actions, options),
    };
}

/** コミュニティ機能が無いギルドでは作れない種別を代替する。 */
function effectiveChannelType(type, features) {
    if (features.has('COMMUNITY')) return type;
    if (type === ChannelType.GuildAnnouncement) return ChannelType.GuildText;
    if (type === ChannelType.GuildStageVoice) return ChannelType.GuildVoice;
    return type;
}

const CHANNEL_REF_FIELDS = ['afkChannelId', 'systemChannelId', 'rulesChannelId', 'publicUpdatesChannelId', 'safetyAlertsChannelId'];
const SCALAR_FIELDS = [
    'name', 'description', 'verificationLevel', 'explicitContentFilter', 'defaultMessageNotifications',
    'systemChannelFlags', 'afkTimeout', 'preferredLocale', 'premiumProgressBarEnabled',
];

/**
 * ギルド設定の変更点。チャンネル参照は「バックアップ側で設定されていて、現在は未設定」の場合のみ入れる。
 * 画像も現在未設定の場合のみ入れる（既存のアイコン等を上書きしない）。
 */
function diffGuildSettings(snap, cur, currentAssets, features) {
    const changes = {};
    for (const f of SCALAR_FIELDS) {
        if (f === 'description' && !features.has('COMMUNITY')) continue;
        if (snap[f] !== cur[f] && snap[f] != null) changes[f] = snap[f];
    }
    for (const f of CHANNEL_REF_FIELDS) {
        if ((f === 'rulesChannelId' || f === 'publicUpdatesChannelId' || f === 'safetyAlertsChannelId') && !features.has('COMMUNITY')) continue;
        if (snap[f] && !cur[f]) changes[f] = snap[f];
    }
    if (snap.icon && !currentAssets.icon) changes.icon = snap.icon;
    if (snap.banner && !currentAssets.banner && features.has('BANNER')) changes.banner = snap.banner;
    if (snap.splash && !currentAssets.splash && features.has('INVITE_SPLASH')) changes.splash = snap.splash;
    return changes;
}

/**
 * dry-run の結果に紐づく確認コード。実行時にプランを再計算し、
 * コードが一致しなければ（その間にサーバーが変わった等）実行しない。
 */
function confirmCodeFor(backupId, targetGuildId, actions, options) {
    const canonical = JSON.stringify({
        backupId,
        targetGuildId,
        guildSettings: Boolean(options.guildSettings),
        actions: actions.map((a) => [a.op, a.entity, a.ref, a.targetId ?? null, a.detail ?? null]),
    });
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8).toUpperCase();
}

module.exports = { buildRestorePlan, diffGuildSettings, effectiveChannelType, confirmCodeFor };

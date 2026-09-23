'use strict';

// Guild オブジェクトからデータモデル (models/backup.js) 形式のスナップショットを作る。
// assetSink を渡すと画像をダウンロードして保存する（export 用）。
// 渡さない場合は画像なしのスナップショットになる（restore の差分計算用）。

const { ChannelType, WebhookType } = require('discord.js');

// バックアップ対象のチャンネル種別（スレッド等は対象外）
const CHANNEL_TYPES = new Set([
    ChannelType.GuildText,
    ChannelType.GuildVoice,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildStageVoice,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
]);

/**
 * @typedef {Object} SnapshotOptions
 * @property {(baseName: string, url: string|null) => Promise<import('../models/backup').AssetRef|null>} [assetSink]
 * @property {(label: string, fn: () => Promise<any>) => Promise<any>} [call]   API呼び出しのラッパー（キュー）
 * @property {string[]} [warnings]
 */

/**
 * @param {import('discord.js').Guild} guild
 * @param {SnapshotOptions} [opts]
 */
async function snapshotGuild(guild, { assetSink, call = (_l, fn) => fn(), warnings = [] } = {}) {
    const asset = async (name, url) => (assetSink && url ? assetSink(name, url) : null);

    const roles = await call('roles.fetch', () => guild.roles.fetch());
    const channels = await call('channels.fetch', () => guild.channels.fetch());
    const emojis = await call('emojis.fetch', () => guild.emojis.fetch());
    const stickers = await call('stickers.fetch', () => guild.stickers.fetch());

    let webhooks = [];
    try {
        const all = await call('webhooks.fetch', () => guild.fetchWebhooks());
        webhooks = [...all.values()].filter((w) => w.type === WebhookType.Incoming && w.channelId);
    } catch (err) {
        warnings.push(`Webhook を取得できませんでした（ManageWebhooks 権限を確認）: ${err.message}`);
    }

    /** @type {import('../models/backup').RoleSnapshot[]} */
    const roleSnaps = [];
    for (const r of [...roles.values()].sort((a, b) => a.position - b.position)) {
        roleSnaps.push({
            id: r.id,
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            mentionable: r.mentionable,
            permissions: r.permissions.bitfield.toString(),
            position: r.position,
            managed: r.managed,
            isEveryone: r.id === guild.id,
            icon: await asset(`role-${r.id}`, r.icon ? r.iconURL({ extension: 'png', size: 256 }) : null),
            unicodeEmoji: r.unicodeEmoji ?? null,
        });
    }

    const overwritesOf = (ch) => {
        const out = [];
        let memberOverwrites = 0;
        for (const ow of ch.permissionOverwrites.cache.values()) {
            // type 0 = role, 1 = member。メンバー個別のものは個人データなので保存しない。
            if (ow.type !== 0) {
                memberOverwrites++;
                continue;
            }
            out.push({ roleId: ow.id, allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() });
        }
        if (memberOverwrites) warnings.push(`#${ch.name}: メンバー個別の権限オーバーライド ${memberOverwrites} 件は保存対象外です`);
        return out;
    };

    const all = [...channels.values()].filter(Boolean);
    const categories = all
        .filter((c) => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name, position: c.rawPosition, overwrites: overwritesOf(c) }));

    const channelSnaps = all
        .filter((c) => CHANNEL_TYPES.has(c.type))
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            parentId: c.parentId ?? null,
            position: c.rawPosition,
            permissionsSynced: c.parentId ? Boolean(c.permissionsLocked) : false,
            overwrites: overwritesOf(c),
            topic: c.topic ?? null,
            nsfw: Boolean(c.nsfw),
            rateLimitPerUser: c.rateLimitPerUser ?? null,
            bitrate: c.bitrate ?? null,
            userLimit: c.userLimit ?? null,
            rtcRegion: c.rtcRegion ?? null,
            videoQualityMode: c.videoQualityMode ?? null,
            defaultAutoArchiveDuration: c.defaultAutoArchiveDuration ?? null,
            defaultThreadRateLimitPerUser: c.defaultThreadRateLimitPerUser ?? null,
            availableTags: c.availableTags
                ? c.availableTags.map((t) => ({
                    name: t.name,
                    moderated: t.moderated,
                    emojiId: t.emoji?.id ?? null,
                    emojiName: t.emoji?.name ?? null,
                }))
                : null,
            defaultReactionEmoji: c.defaultReactionEmoji
                ? { emojiId: c.defaultReactionEmoji.id ?? null, emojiName: c.defaultReactionEmoji.name ?? null }
                : null,
            defaultSortOrder: c.defaultSortOrder ?? null,
            defaultForumLayout: c.defaultForumLayout ?? null,
        }));

    const emojiSnaps = [];
    for (const e of emojis.values()) {
        if (e.managed) continue; // Twitch 連携等の絵文字は作成できない
        emojiSnaps.push({
            id: e.id,
            name: e.name,
            animated: Boolean(e.animated),
            roleIds: [...e.roles.cache.keys()],
            asset: await asset(`emoji-${e.id}`, emojiUrl(e)),
        });
    }

    const stickerSnaps = [];
    for (const s of stickers.values()) {
        stickerSnaps.push({
            id: s.id,
            name: s.name,
            description: s.description ?? null,
            tags: s.tags ?? '',
            format: s.format,
            asset: await asset(`sticker-${s.id}`, s.url),
        });
    }

    const webhookSnaps = [];
    for (const w of webhooks) {
        // token / url はここで明示的に落とす（スプレッド構文で丸ごと入れない）
        webhookSnaps.push({
            id: w.id,
            name: w.name,
            channelId: w.channelId,
            avatar: await asset(`webhook-${w.id}`, w.avatar ? w.avatarURL({ extension: 'png', size: 256 }) : null),
        });
    }

    /** @type {import('../models/backup').GuildSettingsSnapshot} */
    const settings = {
        name: guild.name,
        description: guild.description ?? null,
        icon: await asset('guild-icon', guild.icon ? guild.iconURL({ extension: 'png', size: 1024 }) : null),
        banner: await asset('guild-banner', guild.banner ? guild.bannerURL({ extension: 'png', size: 1024 }) : null),
        splash: await asset('guild-splash', guild.splash ? guild.splashURL({ extension: 'png', size: 1024 }) : null),
        verificationLevel: guild.verificationLevel,
        explicitContentFilter: guild.explicitContentFilter,
        defaultMessageNotifications: guild.defaultMessageNotifications,
        systemChannelFlags: Number(guild.systemChannelFlags.bitfield),
        afkChannelId: guild.afkChannelId ?? null,
        afkTimeout: guild.afkTimeout,
        systemChannelId: guild.systemChannelId ?? null,
        rulesChannelId: guild.rulesChannelId ?? null,
        publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
        safetyAlertsChannelId: guild.safetyAlertsChannelId ?? null,
        preferredLocale: guild.preferredLocale,
        premiumProgressBarEnabled: Boolean(guild.premiumProgressBarEnabled),
        features: [...guild.features],
        premiumTier: guild.premiumTier,
    };

    return {
        guild: settings,
        roles: roleSnaps,
        categories,
        channels: channelSnaps,
        emojis: emojiSnaps,
        stickers: stickerSnaps,
        webhooks: webhookSnaps,
        warnings,
    };
}

function emojiUrl(e) {
    const ext = e.animated ? 'gif' : 'png';
    if (typeof e.imageURL === 'function') return e.imageURL({ extension: ext });
    return e.url;
}

module.exports = { snapshotGuild, CHANNEL_TYPES };

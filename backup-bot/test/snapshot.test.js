'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, WebhookType, PermissionsBitField, Collection } = require('discord.js');
const { snapshotGuild } = require('../src/backup/snapshot');
const { channelCreateOptions } = require('../src/restore/executor');

const GID = '100000000000000001';
const col = (items) => new Collection(items.map((x) => [x.id, x]));
const perms = (n) => new PermissionsBitField(BigInt(n));
const overwrites = (list) => ({ cache: col(list.map((o) => ({ ...o, allow: perms(o.allow), deny: perms(o.deny) }))) });

function fakeGuild() {
    const roles = col([
        { id: GID, name: '@everyone', color: 0, hoist: false, mentionable: false, permissions: perms(1024), position: 0, managed: false, icon: null },
        { id: '11', name: 'Mod', color: 1, hoist: true, mentionable: false, permissions: perms(8), position: 1, managed: false, icon: null },
    ]);
    const channels = col([
        { id: '21', name: 'cat', type: ChannelType.GuildCategory, rawPosition: 0, permissionOverwrites: overwrites([]) },
        {
            id: '31', name: 'chat', type: ChannelType.GuildText, rawPosition: 0, parentId: '21', permissionsLocked: false, topic: 't', nsfw: false, rateLimitPerUser: 5,
            permissionOverwrites: overwrites([{ id: '11', type: 0, allow: 1024, deny: 0 }, { id: '999', type: 1, allow: 1024, deny: 0 }]),
        },
        { id: '32', name: 'thread', type: ChannelType.PublicThread, rawPosition: 0, permissionOverwrites: overwrites([]) },
    ]);
    const webhooks = col([
        { id: '61', name: 'hook', type: WebhookType.Incoming, channelId: '31', token: 'SECRET', url: 'https://discord.com/api/webhooks/61/SECRET', avatar: null },
        { id: '62', name: 'follow', type: WebhookType.ChannelFollower, channelId: '31', avatar: null },
    ]);
    return {
        id: GID, name: 'G', description: null, icon: null, banner: null, splash: null, verificationLevel: 1, explicitContentFilter: 0,
        defaultMessageNotifications: 1, systemChannelFlags: { bitfield: 0 }, afkChannelId: null, afkTimeout: 300, systemChannelId: '31',
        rulesChannelId: null, publicUpdatesChannelId: null, safetyAlertsChannelId: null, preferredLocale: 'ja', premiumProgressBarEnabled: false,
        features: [], premiumTier: 0,
        roles: { fetch: async () => roles },
        channels: { fetch: async () => channels },
        emojis: { fetch: async () => col([]) },
        stickers: { fetch: async () => col([]) },
        fetchWebhooks: async () => webhooks,
    };
}

test('snapshotGuild: 秘匿情報・メンバー個別オーバーライド・スレッドを含めない', async () => {
    const snap = await snapshotGuild(fakeGuild());
    const json = JSON.stringify(snap);
    assert.ok(!json.includes('SECRET'));
    assert.deepEqual(snap.webhooks, [{ id: '61', name: 'hook', channelId: '31', avatar: null }]);
    assert.deepEqual(snap.channels.map((c) => c.name), ['chat']);
    assert.deepEqual(snap.channels[0].overwrites, [{ roleId: '11', allow: '1024', deny: '0' }]);
    assert.ok(!json.includes('"999"'));
    assert.ok(snap.warnings.some((w) => w.includes('メンバー個別')));
    assert.equal(snap.roles.find((r) => r.isEveryone).id, GID);
});

test('channelCreateOptions: ボイスのビットレートは上限に丸める', () => {
    const opts = channelCreateOptions(
        { name: 'vc', bitrate: 384000, userLimit: 5, rtcRegion: null, videoQualityMode: null, nsfw: false, rateLimitPerUser: 0 },
        ChannelType.GuildVoice,
        { guild: { maximumBitrate: 96000 }, parent: null, permissionOverwrites: [], emojiMap: new Map() },
    );
    assert.equal(opts.bitrate, 96000);
    assert.equal(opts.userLimit, 5);
    assert.equal(opts.topic, undefined);
});

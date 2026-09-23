'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { buildRestorePlan } = require('../src/restore/planner');

const SRC = '100000000000000001';
const DST = '200000000000000002';
const ALL = (PermissionFlagsBits.Administrator).toString();

const emptyGuild = {
    name: 'x', description: null, icon: null, banner: null, splash: null, verificationLevel: 0, explicitContentFilter: 0,
    defaultMessageNotifications: 0, systemChannelFlags: 0, afkChannelId: null, afkTimeout: 300, systemChannelId: null,
    rulesChannelId: null, publicUpdatesChannelId: null, safetyAlertsChannelId: null, preferredLocale: 'ja',
    premiumProgressBarEnabled: false, features: [], premiumTier: 0,
};

function role(id, name, position, extra = {}) {
    return { id, name, color: 0, hoist: false, mentionable: false, permissions: '0', position, managed: false, isEveryone: false, icon: null, unicodeEmoji: null, ...extra };
}
function channel(id, name, parentId, position, type = ChannelType.GuildText) {
    return {
        id, name, type, parentId, position, permissionsSynced: false, overwrites: [], topic: null, nsfw: false,
        rateLimitPerUser: 0, bitrate: null, userLimit: null, rtcRegion: null, videoQualityMode: null,
        defaultAutoArchiveDuration: null, defaultThreadRateLimitPerUser: null, availableTags: null,
        defaultReactionEmoji: null, defaultSortOrder: null, defaultForumLayout: null,
    };
}

function manifest() {
    return {
        schemaVersion: 1, id: '20260923T000000Z-abcdef', createdAt: '', createdBy: '1', label: null,
        source: { guildId: SRC, guildName: 'src' },
        guild: { ...emptyGuild, name: 'Backup Name', verificationLevel: 2 },
        roles: [
            role(SRC, '@everyone', 0, { isEveryone: true }),
            role('11', 'Member', 1),
            role('12', 'Mod', 2),
            role('13', 'SomeBot', 3, { managed: true }),
        ],
        categories: [{ id: '21', name: 'General', position: 0, overwrites: [] }],
        channels: [
            channel('31', 'chat', '21', 0),
            channel('32', 'news', null, 1, ChannelType.GuildAnnouncement),
        ],
        emojis: [{ id: '41', name: 'smile', animated: false, roleIds: [], asset: { file: 'emoji-41.png', sha256: 'x', contentType: 'image/png', bytes: 1 } }],
        stickers: [{ id: '51', name: 'lottie', description: null, tags: 'x', format: 3, asset: null }],
        webhooks: [{ id: '61', name: 'notifier', channelId: '31', avatar: null }],
        warnings: [],
    };
}

function emptyCurrent() {
    return {
        guild: { ...emptyGuild },
        roles: [role(DST, '@everyone', 0, { isEveryone: true })],
        categories: [], channels: [], emojis: [], stickers: [], webhooks: [], warnings: [],
    };
}

function ctx(current, extra = {}) {
    return {
        targetGuildId: DST, current, features: [], premiumTier: 0, botPermissions: ALL,
        currentAssets: { icon: false, banner: false, splash: false }, ...extra,
    };
}

test('空のギルドへの復元: 不足分をすべて作成、作成不能なものはスキップ', () => {
    const plan = buildRestorePlan(manifest(), ctx(emptyCurrent()));
    const find = (entity, name) => plan.actions.find((a) => a.entity === entity && a.name === name);

    assert.equal(find('role', 'Mod').op, 'create');
    assert.equal(find('role', 'Member').op, 'create');
    assert.equal(find('role', 'SomeBot').op, 'skip');
    assert.equal(find('category', 'General').op, 'create');
    assert.equal(find('channel', 'chat').op, 'create');
    assert.equal(find('emoji', 'smile').op, 'create');
    assert.equal(find('sticker', 'lottie').op, 'skip');
    assert.equal(find('webhook', 'notifier').op, 'create');
    // ギルド設定は明示指定しない限り触らない
    assert.equal(find('guild', 'Backup Name'), undefined);
});

test('ロールは上位から順に作成される（相対順序を保つため）', () => {
    const plan = buildRestorePlan(manifest(), ctx(emptyCurrent()));
    const roleCreates = plan.actions.filter((a) => a.entity === 'role' && a.op === 'create').map((a) => a.name);
    assert.deepEqual(roleCreates, ['Mod', 'Member']);
});

test('コミュニティ未有効ならアナウンスチャンネルはテキストで作成', () => {
    const plan = buildRestorePlan(manifest(), ctx(emptyCurrent()));
    const news = plan.actions.find((a) => a.name === 'news');
    assert.equal(news.detail.type, ChannelType.GuildText);
    const withCommunity = buildRestorePlan(manifest(), ctx(emptyCurrent(), { features: ['COMMUNITY'] }));
    assert.equal(withCommunity.actions.find((a) => a.name === 'news').detail.type, ChannelType.GuildAnnouncement);
});

test('既存の同名ロール/チャンネルは再利用し、変更しない（非破壊）', () => {
    const cur = emptyCurrent();
    cur.roles.push(role('900', 'Mod', 5, { permissions: '8' }));
    cur.categories.push({ id: '901', name: 'General', position: 0, overwrites: [] });
    cur.channels.push(channel('902', 'chat', '901', 0));
    cur.webhooks.push({ id: '903', name: 'notifier', channelId: '902', avatar: null });

    const plan = buildRestorePlan(manifest(), ctx(cur));
    const find = (entity, name) => plan.actions.find((a) => a.entity === entity && a.name === name);
    assert.deepEqual([find('role', 'Mod').op, find('role', 'Mod').targetId], ['reuse', '900']);
    assert.deepEqual([find('category', 'General').op, find('category', 'General').targetId], ['reuse', '901']);
    assert.deepEqual([find('channel', 'chat').op, find('channel', 'chat').targetId], ['reuse', '902']);
    assert.equal(find('webhook', 'notifier').op, 'reuse');
    // プランに delete / 既存への update が含まれないこと
    assert.ok(plan.actions.every((a) => a.op !== 'delete' && !(a.op === 'update' && a.entity !== 'guild')));
});

test('同名チャンネルでも親カテゴリが違えば別物として作成', () => {
    const cur = emptyCurrent();
    cur.categories.push({ id: '901', name: 'Other', position: 0, overwrites: [] });
    cur.channels.push(channel('902', 'chat', '901', 0));
    const plan = buildRestorePlan(manifest(), ctx(cur));
    assert.equal(plan.actions.find((a) => a.entity === 'channel' && a.name === 'chat').op, 'create');
});

test('確認コードは同じ状態なら同一、状態が変われば変わる', () => {
    const a = buildRestorePlan(manifest(), ctx(emptyCurrent()));
    const b = buildRestorePlan(manifest(), ctx(emptyCurrent()));
    assert.equal(a.confirmCode, b.confirmCode);
    assert.match(a.confirmCode, /^[0-9A-F]{8}$/);

    const cur = emptyCurrent();
    cur.roles.push(role('900', 'Mod', 5));
    assert.notEqual(buildRestorePlan(manifest(), ctx(cur)).confirmCode, a.confirmCode);
    assert.notEqual(buildRestorePlan(manifest(), ctx(emptyCurrent()), { guildSettings: true }).confirmCode, a.confirmCode);
});

test('guildSettings 指定時のみギルド設定を更新し、既存アイコンは上書きしない', () => {
    const m = manifest();
    m.guild.icon = { file: 'guild-icon.png', sha256: 'x', contentType: 'image/png', bytes: 1 };
    const plan = buildRestorePlan(m, ctx(emptyCurrent(), { currentAssets: { icon: true, banner: false, splash: false } }), { guildSettings: true });
    const g = plan.actions.find((a) => a.entity === 'guild');
    assert.equal(g.op, 'update');
    assert.ok(g.detail.fields.includes('name'));
    assert.ok(g.detail.fields.includes('verificationLevel'));
    assert.ok(!g.detail.fields.includes('icon'));
});

test('Botが持たない権限は警告付きで除外される', () => {
    const m = manifest();
    m.roles[2].permissions = (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles).toString();
    const plan = buildRestorePlan(m, ctx(emptyCurrent(), { botPermissions: PermissionFlagsBits.ManageRoles.toString() }));
    const mod = plan.actions.find((a) => a.entity === 'role' && a.name === 'Mod');
    assert.equal(mod.op, 'create');
    assert.match(mod.reason, /除外/);
    assert.ok(plan.warnings.some((w) => w.includes('不足')));
});

test('絵文字枠が埋まっていればスキップ', () => {
    const cur = emptyCurrent();
    for (let i = 0; i < 50; i++) cur.emojis.push({ id: `7${i}`, name: `e${i}`, animated: false, roleIds: [], asset: null });
    const plan = buildRestorePlan(manifest(), ctx(cur));
    assert.equal(plan.actions.find((a) => a.entity === 'emoji').op, 'skip');
});

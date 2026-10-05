// features/voice_panel/service.js — 一時ボイスチャンネル パネル（yoshitoroidoracle から移植）
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, UserSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ChannelType,
} = require('discord.js');
const path = require('path');
const { DATA_DIR } = require('../../dataPath');
const { readJson, writeJson } = require('../../lib/jsonFile');

// 管理者権限が無くても全部屋のパネルを操作できるロール（任意）
const ADMIN_ROLE_ID = process.env.VOICE_PANEL_ADMIN_ROLE_ID || null;

// 管理者は自分の部屋でなくても、どの一時ボイスチャンネルのパネルも操作できる
function isRoomAdmin(member) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions.has('Administrator')) return true;
    return !!ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID);
}

const SETTINGS_FILE       = path.join(DATA_DIR, 'voice_panel_settings.json');
const OWNERS_FILE         = path.join(DATA_DIR, 'voice_panel_owners.json');
const PROFILES_FILE       = path.join(DATA_DIR, 'voice_panel_profiles.json');
const PANEL_MESSAGES_FILE = path.join(DATA_DIR, 'voice_panel_messages.json');

function getVPSettings() {
    return {
        joinChannelId: null, categoryId: null,
        notifyChannelId: null, notifyRoleId: null, notifyMinutes: 5,
        bannedUserIds: [], bannedRoleIds: [],
        ...readJson(SETTINGS_FILE, {}),
    };
}
function saveVPSettings(settings) {
    writeJson(SETTINGS_FILE, settings);
}

function getOwners() {
    return readJson(OWNERS_FILE, {});
}
function saveOwners(owners) {
    writeJson(OWNERS_FILE, owners);
}
function getTempOwner(channelId) {
    return getOwners()[channelId] ?? null;
}
function setTempOwner(channelId, userId) {
    const owners = getOwners();
    owners[channelId] = userId;
    saveOwners(owners);
}
function deleteTempOwner(channelId) {
    const owners = getOwners();
    delete owners[channelId];
    saveOwners(owners);
    deletePanelMessageId(channelId);
}

// パネル埋め込みメッセージのID（出禁リスト等の変更時に編集して反映するため）
function getPanelMessages() {
    return readJson(PANEL_MESSAGES_FILE, {});
}
function savePanelMessages(messages) {
    writeJson(PANEL_MESSAGES_FILE, messages);
}
function getPanelMessageId(channelId) {
    return getPanelMessages()[channelId] ?? null;
}
function setPanelMessageId(channelId, messageId) {
    const messages = getPanelMessages();
    messages[channelId] = messageId;
    savePanelMessages(messages);
}
function deletePanelMessageId(channelId) {
    const messages = getPanelMessages();
    delete messages[channelId];
    savePanelMessages(messages);
}

/* ===== 部屋プロフィール（オーナー単位で永続化・管理者のみ変更） ===== */
function getProfiles() {
    return readJson(PROFILES_FILE, {});
}
function saveProfiles(profiles) {
    writeJson(PROFILES_FILE, profiles);
}
function getRoomProfile(ownerId) {
    const profiles = getProfiles();
    return {
        bannedUserIds: [], bannedRoleIds: [],
        defaultUserLimit: null, defaultLocked: false, nsfw: false,
        ...profiles[ownerId],
    };
}
function saveRoomProfile(ownerId, profile) {
    const profiles = getProfiles();
    profiles[ownerId] = profile;
    saveProfiles(profiles);
}

// そのオーナーが現在保有している一時チャンネルIDを探す
function findActiveChannelId(ownerId) {
    const owners = getOwners();
    return Object.keys(owners).find(chId => owners[chId] === ownerId) ?? null;
}

// ID一覧をメンション表示用に整形（embedのフィールド文字数上限1024を超えないよう40件で打ち切り）
function formatMentionList(ids, mentionPrefix = '@') {
    if (!ids.length) return 'なし';
    const MAX = 40;
    const shown = ids.slice(0, MAX).map(id => `<${mentionPrefix}${id}>`).join(' ');
    return ids.length > MAX ? `${shown} 他${ids.length - MAX}件` : shown;
}

// 出禁対象かどうか（オーナー本人は常に除外＝自分のロール出禁で締め出されない）
function isBanned(member, profile, ownerId) {
    if (member.id === ownerId) return false;
    if (profile.bannedUserIds.includes(member.id)) return true;
    return profile.bannedRoleIds.some(rid => member.roles.cache.has(rid));
}

// 一時ボイスチャンネル機能自体の利用を禁止されているか（サーバー全体・管理者設定）
function isGloballyBanned(member, settings) {
    if (settings.bannedUserIds.includes(member.id)) return true;
    return settings.bannedRoleIds.some(rid => member.roles.cache.has(rid));
}

/* ===== /voicepanel serverban コマンド ===== */
async function handleVoiceBan(interaction) {
    const action = interaction.options.getString('action');
    const user   = interaction.options.getUser('user');
    const role   = interaction.options.getRole('role');
    const settings = getVPSettings();

    if (action === 'list') {
        return interaction.reply({
            content: [
                `📋 出禁ユーザー: ${formatMentionList(settings.bannedUserIds, '@')}`,
                `📋 出禁ロール: ${formatMentionList(settings.bannedRoleIds, '@&')}`,
            ].join('\n'),
            ephemeral: true,
        });
    }

    if (!user && !role) {
        return interaction.reply({ content: '❌ user または role のどちらかを指定してください。', ephemeral: true });
    }

    if (action === 'add') {
        if (user && !settings.bannedUserIds.includes(user.id)) settings.bannedUserIds.push(user.id);
        if (role && !settings.bannedRoleIds.includes(role.id)) settings.bannedRoleIds.push(role.id);
        saveVPSettings(settings);
        if (user) {
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (member?.voice.channel && (member.voice.channelId === settings.joinChannelId || getTempOwner(member.voice.channelId))) {
                await member.voice.disconnect().catch(() => {});
            }
        }
        return interaction.reply({
            content: `✅ ${user ?? role} を一時ボイスチャンネル機能から出禁にしました（作成・参加とも不可）。`,
            ephemeral: true,
        });
    }

    if (action === 'remove') {
        if (user) settings.bannedUserIds = settings.bannedUserIds.filter(id => id !== user.id);
        if (role) settings.bannedRoleIds = settings.bannedRoleIds.filter(id => id !== role.id);
        saveVPSettings(settings);
        return interaction.reply({ content: `✅ ${user ?? role} の出禁を解除しました。`, ephemeral: true });
    }
}

// オーナーは常にConnect/ViewChannelを明示許可し、出禁ユーザー/ロールを個別に拒否する。
// .edit()/.delete()は対象IDだけを操作するため、カテゴリ由来のオーバーライドや
// ロック/非表示状態など、他のオーバーライドを巻き込んで消すことがない。
// ロール/メンバーを実オブジェクトで渡し、discord.js側でのID解決の失敗（＝
// オーナー許可オーバーライドが作成されず締め出される事故）を避ける。
async function applyBanOverwrites(channel, ownerId, profile) {
    const guild = channel.guild;
    const owner = await guild.members.fetch(ownerId).catch(() => null);
    await channel.permissionOverwrites.edit(owner ?? ownerId, { Connect: true, ViewChannel: true }).catch(() => {});

    for (const uid of profile.bannedUserIds) {
        if (uid === ownerId) continue;
        const member = await guild.members.fetch(uid).catch(() => null);
        await channel.permissionOverwrites.edit(member ?? uid, { Connect: false, ViewChannel: false }).catch(() => {});
    }
    for (const rid of profile.bannedRoleIds) {
        const role = guild.roles.cache.get(rid);
        await channel.permissionOverwrites.edit(role ?? rid, { Connect: false, ViewChannel: false }).catch(() => {});
    }
}

// 管理者が出禁設定を変更した際、既に存在する一時チャンネルへ即時反映する
async function applyProfileToActiveChannel(guild, ownerId, { unbannedUser, unbannedRole } = {}) {
    const channelId = findActiveChannelId(ownerId);
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;

    if (unbannedUser) await channel.permissionOverwrites.delete(unbannedUser).catch(() => {});
    if (unbannedRole) await channel.permissionOverwrites.delete(unbannedRole).catch(() => {});

    const profile = getRoomProfile(ownerId);
    await applyBanOverwrites(channel, ownerId, profile);

    // 現在接続中の出禁対象を切断
    for (const member of channel.members.values()) {
        if (isBanned(member, profile, ownerId)) await member.voice.disconnect().catch(() => {});
    }

    await refreshPanelEmbed(channel, ownerId);
}

const USER_LIMIT_CHOICES = [0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 99];

const UM_SELECT_TEXT_BY_ACTION = {
    ban:      { placeholder: 'ブロックするユーザーを選択', content: '⛔ **ブロック**: 選択したユーザーはこの部屋に今後ずっと接続・閲覧できなくなります（部屋を削除しても引き継がれます）。' },
    unban:    { placeholder: 'ブロック解除するユーザーを選択', content: '✅ **ブロック解除**: 選択したユーザーのブロックを解除します。' },
    mute:     { placeholder: 'ミュートするユーザーを選択', content: '🔇 **ミュート**: 選択したユーザーをミュートします（一時的・退出でリセット）。' },
    unmute:   { placeholder: 'ミュート解除するユーザーを選択', content: '🔊 **ミュート解除**: 選択したユーザーのミュートを解除します。' },
    deafen:   { placeholder: 'スピーカーミュートするユーザーを選択', content: '🔕 **スピーカーミュート**: 選択したユーザーの音声受信を止めます（一時的・退出でリセット）。' },
    undeafen: { placeholder: 'スピーカーミュート解除するユーザーを選択', content: '🔔 **スピーカーミュート解除**: 選択したユーザーのスピーカーミュートを解除します。' },
};

/* ===== パネル embed & コンポーネント ===== */
function buildPanelEmbed(guild, ownerId = null) {
    const embed = new EmbedBuilder()
        .setAuthor({ name: '一時ボイスチャンネル パネル', iconURL: guild.client.user.displayAvatarURL() })
        .setDescription('*ボタンを押して、自分の一時ボイスチャンネルを操作できます。*')
        .setColor(0x5865F2)
        .setFooter({ text: guild.name, iconURL: guild.iconURL() ?? undefined })
        .setTimestamp();

    if (ownerId) {
        const profile = getRoomProfile(ownerId);
        embed.addFields({ name: '⛔ ブロックリスト', value: formatMentionList(profile.bannedUserIds, '@') });
    }
    return embed;
}

// 出禁リストの変更などをパネルの埋め込みに反映する。呼び出し元でのハンドリング漏れを
// 避けるため、失敗（embed組み立て・API呼び出しとも）はここで完結させ例外を伝播させない。
async function refreshPanelEmbed(channel, ownerId) {
    try {
        const messageId = getPanelMessageId(channel.id);
        if (!messageId) return;
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return;
        await message.edit({ embeds: [buildPanelEmbed(channel.guild, ownerId)] }).catch(() => {});
    } catch (e) {
        console.error('[VoicePanel] パネル更新エラー:', e);
    }
}

function buildPanelComponents() {
    const rowOne = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vcpanel_lock').setLabel('ロック').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_unlock').setLabel('ロック解除').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_hide').setLabel('非表示').setEmoji('🙈').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_unhide').setLabel('表示').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    );
    const rowTwo = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vcpanel_mute').setLabel('全員ミュート').setEmoji('🔇').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_unmute').setLabel('全員ミュート解除').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_userlimit_modal').setLabel('人数上限を指定').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_disconnect').setLabel('全員切断').setEmoji('📞').setStyle(ButtonStyle.Danger),
    );
    const rowThree = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vcpanel_usersmanager').setLabel('ユーザー管理').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_ban').setLabel('ブロック').setEmoji('⛔').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vcpanel_unban').setLabel('ブロック解除').setEmoji('✅').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('vcpanel_rename').setLabel('名前を変更').setEmoji('📝').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('vcpanel_delete').setLabel('チャンネルを削除').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    );
    const rowFour = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('vcpanel_userlimit')
            .setPlaceholder('人数制限を選択')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(USER_LIMIT_CHOICES.map(n => ({ label: n === 0 ? '無制限' : `${n}人`, value: `${n}` }))),
    );
    return [rowOne, rowTwo, rowThree, rowFour];
}

/* ===== /voicepanel コマンド ===== */
async function handleVoicePanel(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub   = interaction.options.getSubcommand();

    if (group === 'roomconfig') {
        const owner   = interaction.options.getUser('owner');
        const profile = getRoomProfile(owner.id);

        if (sub === 'ban' || sub === 'unban') {
            const targetUser = interaction.options.getUser('user');
            const targetRole = interaction.options.getRole('role');
            if (!targetUser && !targetRole) {
                return interaction.reply({ content: '❌ user または role のどちらかを指定してください。', ephemeral: true });
            }

            if (sub === 'ban') {
                if (targetUser && !profile.bannedUserIds.includes(targetUser.id)) profile.bannedUserIds.push(targetUser.id);
                if (targetRole && !profile.bannedRoleIds.includes(targetRole.id)) profile.bannedRoleIds.push(targetRole.id);
                saveRoomProfile(owner.id, profile);
                await applyProfileToActiveChannel(interaction.guild, owner.id);
                return interaction.reply({
                    content: `✅ ${owner} の部屋から ${targetUser ?? targetRole} を出禁にしました。`,
                    ephemeral: true,
                });
            }

            if (targetUser) profile.bannedUserIds = profile.bannedUserIds.filter(id => id !== targetUser.id);
            if (targetRole) profile.bannedRoleIds = profile.bannedRoleIds.filter(id => id !== targetRole.id);
            saveRoomProfile(owner.id, profile);
            await applyProfileToActiveChannel(interaction.guild, owner.id, {
                unbannedUser: targetUser, unbannedRole: targetRole,
            });
            return interaction.reply({
                content: `✅ ${owner} の部屋の出禁を解除しました（${targetUser ?? targetRole}）。`,
                ephemeral: true,
            });
        }

        if (sub === 'defaults') {
            const limit  = interaction.options.getInteger('limit');
            const locked = interaction.options.getBoolean('locked');
            const nsfw   = interaction.options.getBoolean('nsfw');
            if (limit !== null)  profile.defaultUserLimit = limit;
            if (locked !== null) profile.defaultLocked    = locked;
            if (nsfw !== null)   profile.nsfw             = nsfw;
            saveRoomProfile(owner.id, profile);
            return interaction.reply({ content: `✅ ${owner} の部屋のデフォルト設定を更新しました。`, ephemeral: true });
        }

        if (sub === 'show') {
            return interaction.reply({
                content: [
                    `📋 対象: ${owner}`,
                    `📋 出禁ユーザー: ${formatMentionList(profile.bannedUserIds, '@')}`,
                    `📋 出禁ロール: ${formatMentionList(profile.bannedRoleIds, '@&')}`,
                    `📋 デフォルト人数制限: ${profile.defaultUserLimit ?? '未設定（参加用チャンネルと同じ）'}`,
                    `📋 デフォルトロック: ${profile.defaultLocked ? '有効' : '無効'}`,
                    `📋 NSFW: ${profile.nsfw ? '有効' : '無効'}`,
                ].join('\n'),
                ephemeral: true,
            });
        }
        return;
    }

    if (sub === 'setup') {
        const joinChannel = interaction.options.getChannel('join_channel');
        const category    = interaction.options.getChannel('category');
        const settings = getVPSettings();
        settings.joinChannelId = joinChannel.id;
        settings.categoryId    = category?.id ?? null;
        saveVPSettings(settings);
        return interaction.reply({
            content: `✅ 参加用チャンネルを ${joinChannel} に設定しました。${category ? `（作成先カテゴリ: ${category}）` : ''}`,
            ephemeral: true,
        });
    }

    if (sub === 'panel') {
        // 任意のテキストチャンネルに投稿できてしまうと、ボタンを押した人自身の
        // 「今いる一時ボイスチャンネル」を無関係な場所から操作できてしまうため、
        // 既存の一時ボイスチャンネルのチャット内でのみ再投稿を許可する
        const ownerId = getTempOwner(interaction.channel.id);
        if (!ownerId) {
            return interaction.reply({
                content: '❌ このコマンドは一時ボイスチャンネルのチャット内でのみ使用できます（パネルを消してしまった場合の再投稿用）。',
                ephemeral: true,
            });
        }
        const embed = buildPanelEmbed(interaction.guild, ownerId);
        const components = buildPanelComponents();
        const panelMsg = await interaction.channel.send({ embeds: [embed], components }).catch(() => null);
        if (panelMsg) setPanelMessageId(interaction.channel.id, panelMsg.id);
        return interaction.reply({ content: '✅ パネルを送信しました。', ephemeral: true });
    }

    if (sub === 'notify') {
        const notifyChannel = interaction.options.getChannel('channel');
        const role          = interaction.options.getRole('role');
        const minutes       = interaction.options.getInteger('minutes') ?? 5;
        const settings = getVPSettings();
        settings.notifyChannelId = notifyChannel.id;
        settings.notifyRoleId    = role?.id ?? null;
        settings.notifyMinutes   = minutes;
        saveVPSettings(settings);
        return interaction.reply({
            content: `✅ 一時ボイスチャンネルの通話が **${minutes}分** 継続した場合、${notifyChannel} に${role ? `${role} をメンションして` : ''}通知します。`,
            ephemeral: true,
        });
    }

    if (sub === 'status') {
        const settings = getVPSettings();
        return interaction.reply({
            content: [
                `📋 参加用チャンネル: ${settings.joinChannelId ? `<#${settings.joinChannelId}>` : '未設定'}`,
                `📋 作成先カテゴリ: ${settings.categoryId ? `<#${settings.categoryId}>` : '参加用チャンネルと同じ'}`,
                `📋 通話通知チャンネル: ${settings.notifyChannelId ? `<#${settings.notifyChannelId}>` : '未設定'}`,
                `📋 通話通知ロール: ${settings.notifyRoleId ? `<@&${settings.notifyRoleId}>` : 'なし'}`,
                `📋 通話通知までの時間: ${settings.notifyMinutes ?? 5}分`,
            ].join('\n'),
            ephemeral: true,
        });
    }
}

/* ===== 通話継続通知 ===== */
const notifyTimers = new Map(); // channelId -> Timeout
const notifyWebhookCache = new Map(); // textChannelId -> Webhook
const callStartTimes = new Map(); // channelId -> 通話開始時刻(ms)

async function getNotifyWebhook(textChannel) {
    if (notifyWebhookCache.has(textChannel.id)) return notifyWebhookCache.get(textChannel.id);
    const hooks = await textChannel.fetchWebhooks();
    let hook = hooks.find(h => h.owner?.id === textChannel.client.user.id && h.token);
    if (!hook) hook = await textChannel.createWebhook({ name: '通話お知らせくん' });
    notifyWebhookCache.set(textChannel.id, hook);
    return hook;
}

function formatDateTimeJST(ts) {
    const d = new Date(ts + 9 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function scheduleCallNotify(channel, settings, ownerId, startedAt) {
    if (!settings.notifyChannelId) return;
    const minutes = settings.notifyMinutes ?? 5;
    const timer = setTimeout(async () => {
        notifyTimers.delete(channel.id);
        const current = channel.guild.channels.cache.get(channel.id);
        if (!current) return; // 通話は既に終了している
        if (current.members.filter(m => !m.user.bot).size === 0) return;

        const notifyChannel = await channel.guild.channels.fetch(settings.notifyChannelId).catch(() => null);
        if (!notifyChannel) return;
        const webhook = await getNotifyWebhook(notifyChannel).catch(() => null);
        if (!webhook) return;

        const owner = await channel.guild.members.fetch(ownerId).catch(() => null);
        const avatarURL = owner?.user.displayAvatarURL({ extension: 'png', size: 128 })
            ?? channel.client.user.displayAvatarURL({ extension: 'png', size: 128 });
        const roleMention = settings.notifyRoleId ? `<@&${settings.notifyRoleId}> ` : '';

        const embed = new EmbedBuilder()
            .setTitle('通話開始')
            .setColor(0xEB459E)
            .addFields(
                { name: 'チャンネル', value: current.name, inline: true },
                { name: '始めた人',   value: `${owner ? owner.displayName : '不明ユーザー'}さん`, inline: true },
                { name: '開始時間',   value: formatDateTimeJST(startedAt), inline: true },
            )
            .setThumbnail(avatarURL);

        await webhook.send({
            content: `${roleMention}通話開始しました。`,
            username: '通話お知らせくん',
            avatarURL,
            embeds: [embed],
            allowedMentions: { roles: settings.notifyRoleId ? [settings.notifyRoleId] : [] },
        }).catch(() => {});
    }, minutes * 60 * 1000);
    notifyTimers.set(channel.id, timer);
}

function cancelCallNotify(channelId) {
    const timer = notifyTimers.get(channelId);
    if (timer) {
        clearTimeout(timer);
        notifyTimers.delete(channelId);
    }
}

// 通話が0人になって一時チャンネルが削除されるタイミングで、終了時刻を記録する（メンションなし）
async function logCallEnd(guild, settings, channelId, channelName, ownerId) {
    const startedAt = callStartTimes.get(channelId);
    callStartTimes.delete(channelId);
    if (!settings.notifyChannelId) return;

    const notifyChannel = await guild.channels.fetch(settings.notifyChannelId).catch(() => null);
    if (!notifyChannel) return;
    const webhook = await getNotifyWebhook(notifyChannel).catch(() => null);
    if (!webhook) return;

    const owner = await guild.members.fetch(ownerId).catch(() => null);
    const avatarURL = owner?.user.displayAvatarURL({ extension: 'png', size: 128 })
        ?? guild.client.user.displayAvatarURL({ extension: 'png', size: 128 });

    const embed = new EmbedBuilder()
        .setTitle('通話終了')
        .setColor(0x99AAB5)
        .addFields(
            { name: 'チャンネル', value: channelName, inline: true },
            { name: '始めた人',   value: `${owner ? owner.displayName : '不明ユーザー'}さん`, inline: true },
            ...(startedAt ? [{ name: '開始時間', value: formatDateTimeJST(startedAt), inline: true }] : []),
            { name: '終了時間',   value: formatDateTimeJST(Date.now()), inline: true },
        )
        .setThumbnail(avatarURL);

    await webhook.send({
        content: '通話終了しました。',
        username: '通話お知らせくん',
        avatarURL,
        embeds: [embed],
        allowedMentions: { parse: [] },
    }).catch(() => {});
}

// voiceStateUpdateの取りこぼしや、管理者による手動削除で所有者情報だけ残った
// ケースに備えて、定期的に空になった一時チャンネルを掃除する（1回だけ登録）
function initVoicePanelCleanup(client) {
    setInterval(async () => {
        const owners = getOwners();
        const settings = getVPSettings();
        for (const channelId of Object.keys(owners)) {
            const ownerId = owners[channelId];
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) {
                deleteTempOwner(channelId);
                cancelCallNotify(channelId);
                callStartTimes.delete(channelId);
                continue;
            }
            if (channel.members.filter(m => !m.user.bot).size === 0) {
                const channelName = channel.name;
                const guild = channel.guild;
                await channel.delete().catch(() => {});
                deleteTempOwner(channelId);
                cancelCallNotify(channelId);
                await logCallEnd(guild, settings, channelId, channelName, ownerId);
            }
        }
    }, 30 * 1000);
}

/* ===== 一時チャンネルの作成・削除 ===== */
async function handleVoicePanelVoiceState(oldState, newState) {
    const settings = getVPSettings();

    // 一時ボイスチャンネル機能自体を禁止されているユーザーは、参加用チャンネル・
    // 既存の一時チャンネルのどちらに入っても即切断し、作成もさせない
    const globallyBanned = newState.channelId && newState.member
        && isGloballyBanned(newState.member, settings)
        && (newState.channelId === settings.joinChannelId || getTempOwner(newState.channelId));
    if (globallyBanned) {
        await newState.member.voice.disconnect().catch(() => {});
    } else if (settings.joinChannelId && newState.channelId === settings.joinChannelId) {
        try {
            const profile = getRoomProfile(newState.member.id);
            const channel = await newState.guild.channels.create({
                name: `${newState.member.displayName}のチャンネル`,
                type: ChannelType.GuildVoice,
                parent: settings.categoryId || newState.channel.parentId,
                userLimit: profile.defaultUserLimit ?? (newState.channel.userLimit || 0),
                nsfw: profile.nsfw,
            });
            setTempOwner(channel.id, newState.member.id);

            await applyBanOverwrites(channel, newState.member.id, profile);
            if (profile.defaultLocked) {
                await channel.permissionOverwrites.edit(newState.guild.roles.everyone, { Connect: false }).catch(() => {});
            }

            await newState.member.voice.setChannel(channel).catch(() => {});
            const panelMsg = await channel.send({
                embeds: [buildPanelEmbed(newState.guild, newState.member.id)],
                components: buildPanelComponents(),
            }).catch(() => null);
            if (panelMsg) setPanelMessageId(channel.id, panelMsg.id);
            const startedAt = Date.now();
            callStartTimes.set(channel.id, startedAt);
            scheduleCallNotify(channel, settings, newState.member.id, startedAt);
        } catch (e) {
            console.error('[VoicePanel] チャンネル作成エラー:', e);
        }
    }

    // 出禁対象が一時チャンネルに残っていたら切断（オーバーライド反映前の入室等への保険）
    if (newState.channelId && newState.member) {
        const roomOwnerId = getTempOwner(newState.channelId);
        if (roomOwnerId) {
            const profile = getRoomProfile(roomOwnerId);
            if (isBanned(newState.member, profile, roomOwnerId)) {
                await newState.member.voice.disconnect().catch(() => {});
            }
        }
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        const ownerId = getTempOwner(oldState.channelId);
        if (ownerId) {
            const channel = oldState.guild.channels.cache.get(oldState.channelId);
            if (channel && channel.members.filter(m => !m.user.bot).size === 0) {
                const channelName = channel.name;
                await channel.delete().catch(() => {});
                deleteTempOwner(oldState.channelId);
                cancelCallNotify(oldState.channelId);
                await logCallEnd(oldState.guild, settings, oldState.channelId, channelName, ownerId);
            }
        }
    }
}

/* ===== 所有者チェック ===== */
function verifyOwner(interaction) {
    // パネルは必ずその一時ボイスチャンネル自身のチャットに置かれるため、
    // 操作対象は「押した人の現在のボイス接続先」ではなく「パネルがあるチャンネル」とする
    const channel = interaction.channel;
    const ownerId = getTempOwner(channel.id);
    if (!ownerId) return { error: '❌ この一時ボイスチャンネルの情報が見つかりません。' };
    if (ownerId !== interaction.user.id && !isRoomAdmin(interaction.member)) {
        return { error: '❌ このチャンネルの所有者ではありません。' };
    }
    return { channel, ownerId };
}

/* ===== ボタン ===== */
async function handleVoicePanelButton(interaction) {
    const { channel, error } = verifyOwner(interaction);
    if (error) return interaction.reply({ content: error, ephemeral: true });

    switch (interaction.customId) {
        case 'vcpanel_lock':
            await interaction.deferUpdate();
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false }).catch(() => {});
            break;
        case 'vcpanel_unlock':
            await interaction.deferUpdate();
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: true }).catch(() => {});
            break;
        case 'vcpanel_hide':
            await interaction.deferUpdate();
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }).catch(() => {});
            break;
        case 'vcpanel_unhide':
            await interaction.deferUpdate();
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: true }).catch(() => {});
            break;
        case 'vcpanel_mute':
            await interaction.deferUpdate();
            for (const member of channel.members.values()) {
                if (member.id !== interaction.user.id) await member.voice.setMute(true).catch(() => {});
            }
            break;
        case 'vcpanel_unmute':
            await interaction.deferUpdate();
            for (const member of channel.members.values()) {
                if (member.id !== interaction.user.id) await member.voice.setMute(false).catch(() => {});
            }
            break;
        case 'vcpanel_disconnect':
            await interaction.deferUpdate();
            for (const member of channel.members.values()) {
                if (member.id !== interaction.user.id) await member.voice.disconnect().catch(() => {});
            }
            break;
        case 'vcpanel_delete': {
            await interaction.deferUpdate();
            const ownerId = getTempOwner(channel.id);
            const channelName = channel.name;
            deleteTempOwner(channel.id);
            cancelCallNotify(channel.id);
            await channel.delete().catch(() => {});
            await logCallEnd(interaction.guild, getVPSettings(), channel.id, channelName, ownerId);
            break;
        }
        case 'vcpanel_rename': {
            const modal = new ModalBuilder().setCustomId('vcpanel_modal_rename').setTitle('チャンネル名を変更');
            const input = new TextInputBuilder()
                .setCustomId('vcpanel_name')
                .setLabel('新しいチャンネル名')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(50)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            break;
        }
        case 'vcpanel_userlimit_modal': {
            const modal = new ModalBuilder().setCustomId('vcpanel_modal_userlimit').setTitle('人数上限を指定');
            const input = new TextInputBuilder()
                .setCustomId('vcpanel_number')
                .setLabel('人数上限（0で無制限、99まで）')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(2)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            break;
        }
        case 'vcpanel_usersmanager': {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('vcpanel_um_mute').setLabel('ミュート').setEmoji('🔇').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('vcpanel_um_unmute').setLabel('ミュート解除').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('vcpanel_um_deafen').setLabel('スピーカーミュート').setEmoji('🔕').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('vcpanel_um_undeafen').setLabel('スピーカーミュート解除').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
            );
            await interaction.reply({ components: [row], ephemeral: true });
            break;
        }
        case 'vcpanel_ban':
        case 'vcpanel_unban':
        case 'vcpanel_um_mute':
        case 'vcpanel_um_unmute':
        case 'vcpanel_um_deafen':
        case 'vcpanel_um_undeafen': {
            const action = interaction.customId.replace('vcpanel_', '').replace('um_', '');
            const UM_SELECT_TEXT = UM_SELECT_TEXT_BY_ACTION[action];
            const row = new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder()
                    .setCustomId(`vcpanel_um_select_${action}`)
                    .setPlaceholder(UM_SELECT_TEXT.placeholder)
                    .setMinValues(1)
                    .setMaxValues(1),
            );
            await interaction.reply({ content: UM_SELECT_TEXT.content, components: [row], ephemeral: true });
            break;
        }
    }
}

/* ===== 人数制限セレクトメニュー ===== */
async function handleVoicePanelSelect(interaction) {
    const { channel, error } = verifyOwner(interaction);
    if (error) return interaction.reply({ content: error, ephemeral: true });
    await interaction.deferUpdate();
    await channel.setUserLimit(parseInt(interaction.values[0], 10)).catch(() => {});
}

/* ===== ユーザー管理セレクトメニュー ===== */
async function handleVoicePanelUserSelect(interaction) {
    const { channel, ownerId, error } = verifyOwner(interaction);
    if (error) return interaction.reply({ content: error, ephemeral: true });
    await interaction.deferUpdate();

    const action   = interaction.customId.replace('vcpanel_um_select_', '');
    const targetId = interaction.values[0];

    // 出禁/出禁解除は部屋の永続プロフィールに反映（部屋を作り直しても引き継がれる）
    if (action === 'ban' || action === 'unban') {
        if (targetId === ownerId) {
            return interaction.editReply({ content: '❌ 部屋の所有者はブロックできません。', components: [] });
        }
        const profile = getRoomProfile(ownerId);
        const target  = await interaction.guild.members.fetch(targetId).catch(() => null);
        const targetMention = target ? `${target}` : `<@${targetId}>`;

        if (action === 'ban') {
            if (!profile.bannedUserIds.includes(targetId)) profile.bannedUserIds.push(targetId);
            saveRoomProfile(ownerId, profile);
            await channel.permissionOverwrites.edit(target ?? targetId, { Connect: false, ViewChannel: false }).catch(() => {});
            if (target?.voice.channelId === channel.id) await target.voice.disconnect().catch(() => {});
        } else {
            profile.bannedUserIds = profile.bannedUserIds.filter(id => id !== targetId);
            saveRoomProfile(ownerId, profile);
            await channel.permissionOverwrites.delete(target ?? targetId).catch(() => {});
        }

        await refreshPanelEmbed(channel, ownerId);

        const listText = formatMentionList(profile.bannedUserIds, '@');
        return interaction.editReply({
            content: action === 'ban'
                ? `⛔ ${targetMention} をこの部屋からブロックしました。\n📋 現在のブロックリスト: ${listText}`
                : `✅ ${targetMention} のブロックを解除しました。\n📋 現在のブロックリスト: ${listText}`,
            components: [],
        });
    }

    const member = channel.members.get(targetId);
    if (!member) return;
    if (action === 'mute')     await member.voice.setMute(true).catch(() => {});
    if (action === 'unmute')   await member.voice.setMute(false).catch(() => {});
    if (action === 'deafen')   await member.voice.setDeaf(true).catch(() => {});
    if (action === 'undeafen') await member.voice.setDeaf(false).catch(() => {});
}

/* ===== モーダル ===== */
async function handleVoicePanelModal(interaction) {
    const { channel, error } = verifyOwner(interaction);
    if (error) return interaction.reply({ content: error, ephemeral: true });

    if (interaction.customId === 'vcpanel_modal_rename') {
        const name = interaction.fields.getTextInputValue('vcpanel_name');
        await channel.setName(name).catch(() => {});
        return interaction.reply({ content: `🪄 チャンネル名を \`${name}\` に変更しました。`, ephemeral: true });
    }

    if (interaction.customId === 'vcpanel_modal_userlimit') {
        const num = parseInt(interaction.fields.getTextInputValue('vcpanel_number'), 10);
        if (Number.isNaN(num) || num < 0 || num > 99) {
            return interaction.reply({ content: '❌ 0〜99の数値を入力してください。', ephemeral: true });
        }
        await channel.setUserLimit(num).catch(() => {});
        return interaction.reply({ content: `🪄 人数上限を \`${num === 0 ? '無制限' : num}\` に変更しました。`, ephemeral: true });
    }
}

module.exports = {
    handleVoicePanel,
    handleVoicePanelVoiceState,
    handleVoicePanelButton,
    handleVoicePanelSelect,
    handleVoicePanelUserSelect,
    handleVoicePanelModal,
    handleVoiceBan,
    initVoicePanelCleanup,
};

// features/auth — 入国審査（呪文認証）・顔パス(VIP)・認証パネル
// 現在は未使用。 .env で ENABLE_AUTH=true のときだけ有効になる（既定は無効）。

const {
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, WHITELIST } = require('../../dataPath');

const ASSETS = {
    logo: path.join(__dirname, '../../assets/logo.png'),
    bg: path.join(__dirname, '../../assets/neverland_bg.png'),
};

const ASSET_CACHE_FILE = path.join(DATA_DIR, 'asset_urls.json');
let assetUrls = { logo: null, bg: null };

function isCdnUrlValid(url) {
    if (!url) return false;
    const match = url.match(/[?&]ex=([0-9a-f]+)/i);
    if (!match) return true;
    return Date.now() < parseInt(match[1], 16) * 1000 - 3600000;
}

async function initAssets(client) {
    try {
        if (fs.existsSync(ASSET_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(ASSET_CACHE_FILE, 'utf8'));
            if (isCdnUrlValid(cached.logo) && isCdnUrlValid(cached.bg)) {
                assetUrls = cached;
                return;
            }
        }
    } catch {}

    const guild = client.guilds.cache.first();
    if (!guild) return;
    const logChannel = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
    if (!logChannel) return;

    const msg = await logChannel.send({
        content: '🖼️',
        files: [
            new AttachmentBuilder(ASSETS.logo, { name: 'logo.png' }),
            new AttachmentBuilder(ASSETS.bg, { name: 'neverland_bg.png' }),
        ],
    });

    assetUrls.logo = msg.attachments.find(a => a.name === 'logo.png')?.url ?? null;
    assetUrls.bg = msg.attachments.find(a => a.name === 'neverland_bg.png')?.url ?? null;
    fs.writeFileSync(ASSET_CACHE_FILE, JSON.stringify(assetUrls));
}

const CONFIG = {
    VERIFY_ROLE_ID: process.env.VERIFY_ROLE_ID,
    VIP_ROLE_ID: process.env.VIP_ROLE_ID,
    AUTH_CHANNEL_ID: process.env.AUTH_CHANNEL_ID,
    WELCOME_CHANNEL_ID: process.env.WELCOME_CHANNEL_ID,
    LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID,
    LIMIT_SECONDS: 30,
    NUMBER_COUNT: 5,
    WHITELIST_FILE: WHITELIST,
};

const AGES = [
    'आठ',     // 8
    'नौ',      // 9
    'दस',     // 10
    'ग्यारह', // 11
    'बारह',   // 12
];

const EMOJIS = ['🪄', '✨', '🌙', '⭐', '💫', '🌟', '🔮'];

function buildPhrase() {
    const age = AGES[Math.floor(Math.random() * AGES.length)];
    const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    return `मैं ${age} साल का हूँ ${emoji}`;
}

function loadWhitelist() {
    try {
        if (!fs.existsSync(CONFIG.WHITELIST_FILE)) {
            fs.writeFileSync(CONFIG.WHITELIST_FILE, '[]');
        }
        return JSON.parse(fs.readFileSync(CONFIG.WHITELIST_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveWhitelist(list) {
    fs.writeFileSync(CONFIG.WHITELIST_FILE, JSON.stringify(list, null, 2));
}

let whitelist = loadWhitelist();
const sessions = new Map();
let authPaused = false;

// ログ送信
async function sendLog(guild, embed) {
    const logChannel = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
    if (!logChannel) return;
    await logChannel.send({ embeds: [embed] }).catch(() => {});
}

async function logSuccess(member) {
    await sendLog(member.guild, new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ にゅうこくせいこう')
        .addFields(
            { name: 'ユーザー', value: `${member} (${member.user.tag})`, inline: true },
            { name: 'ID', value: member.id, inline: true },
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp()
    );
}

async function logFail(member, reason) {
    const reasonText = reason === 'timeout' ? 'じかんぎれ' : reason === 'wrong' ? 'おまじないまちがい' : reason;
    await sendLog(member.guild, new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('❌ にゅうこくしっぱい')
        .addFields(
            { name: 'ユーザー', value: `${member} (${member.user.tag})`, inline: true },
            { name: 'ID', value: member.id, inline: true },
            { name: 'りゆう', value: reasonText, inline: true },
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp()
    );
}


function getProgressBar(timeLeft, total) {
    const filled = Math.max(0, Math.min(10, Math.round((timeLeft / total) * 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function getColor(timeLeft) {
    if (timeLeft <= 10) return 0xED4245;
    if (timeLeft <= 20) return 0xFEE75C;
    return 0x5865F2;
}

function buildNumberButtons(correctNumber) {
    const numbers = new Set([correctNumber]);
    while (numbers.size < CONFIG.NUMBER_COUNT) {
        numbers.add(Math.floor(Math.random() * 90) + 10);
    }

    return new ActionRowBuilder().addComponents(
        [...numbers]
            .sort(() => Math.random() - 0.5)
            .map((n) =>
                new ButtonBuilder()
                    .setCustomId(`numsel_${n}`)
                    .setLabel(String(n))
                    .setStyle(ButtonStyle.Secondary)
            )
    );
}

function buildStep1Embed(member, number, timeLeft, urls = {}) {
    const embed = new EmbedBuilder()
        .setColor(getColor(timeLeft))
        .setTitle('🌙 ネバーランドのとびらまえ')
        .setDescription(
            `${member}、きてくれてありがとう！\n\n` +
            `とびらをあけるには、ちいさなおまじないをこなしてね 🗝️`
        )
        .addFields(
            { name: '🔢 かぎのばんごう', value: `\`${number}\``, inline: true },
            {
                name: '⏳ のこりじかん',
                value: `${getProgressBar(timeLeft, CONFIG.LIMIT_SECONDS)} ${timeLeft}びょう`,
                inline: true,
            }
        )
        .setFooter({ text: 'したのボタンからえらんでね！' });
    if (urls.logo) embed.setThumbnail(urls.logo);
    if (urls.bg) embed.setImage(urls.bg);
    return embed;
}

function buildStep2Embed(phrase, timeLeft, urls = {}) {
    const embed = new EmbedBuilder()
        .setColor(getColor(timeLeft))
        .setTitle('✨ ふるいことばのちかい')
        .setDescription(
            'このふるいことばを、そっと唱えてみて 🌙\n' +
            'このことばが、とびらを開く鍵だよ 🗝️'
        )
        .addFields(
            { name: '🪄 おまじないのことば', value: `\`\`\`${phrase}\`\`\`` },
            {
                name: '⏳ のこりじかん',
                value: `${getProgressBar(timeLeft, CONFIG.LIMIT_SECONDS)} ${timeLeft}びょう`,
            }
        )
        .setFooter({ text: 'ことばの力は、一字一句に宿っているよ ✨' });
    if (urls.logo) embed.setThumbnail(urls.logo);
    if (urls.bg) embed.setImage(urls.bg);
    return embed;
}

async function startAuth(member) {
    const phrase = buildPhrase();
    const number = Math.floor(Math.random() * 90) + 10;

    const authChannel = member.guild.channels.cache.get(CONFIG.AUTH_CHANNEL_ID);
    if (!authChannel) return;

    const thread = await authChannel.threads.create({
        name: `🔑 にゅうこくしんさ-${member.user.username}`,
        autoArchiveDuration: 60,
        type: ChannelType.PrivateThread,
        reason: 'にゅうこくしんさ',
    });

    await thread.members.add(member.id);

    const buttonRow = buildNumberButtons(number);

    const message = await thread.send({
        content: `${member}`,
        embeds: [buildStep1Embed(member, number, CONFIG.LIMIT_SECONDS, assetUrls)],
        components: [buttonRow],
    });

    const session = {
        phrase,
        number,
        step: 1,
        timeLeft: CONFIG.LIMIT_SECONDS,
        message,
        thread,
        buttonRow,
        timer: null,
    };

    sessions.set(member.id, session);

    session.timer = setInterval(async () => {
        const s = sessions.get(member.id);
        if (!s) return;

        s.timeLeft -= 3;

        if (s.timeLeft <= 0) {
            await failAuth(member, s, 'timeout');
            return;
        }

        try {
            await s.message.edit({
                embeds: [
                    s.step === 1
                        ? buildStep1Embed(member, s.number, s.timeLeft, assetUrls)
                        : buildStep2Embed(s.phrase, s.timeLeft, assetUrls),
                ],
                components: s.step === 1 ? [s.buttonRow] : [],
            });
        } catch {}
    }, 3000);
}

async function failAuth(member, session, reason = 'timeout') {
    if (!session) return;

    clearInterval(session.timer);
    sessions.delete(member.id);

    await logFail(member, reason);

    try {
        await member.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('💦 にゅうこくできなかったよ')
                    .setDescription(
                        reason === 'timeout'
                            ? 'じかんぎれになっちゃった！\nもういちどサーバーにはいってちょうせんしてね 🌙'
                            : 'おまじないがちがったみたい…\nもういちどちょうせんしてね 💫'
                    ),
            ],
        });
    } catch {}

    try { await session.thread.delete(); } catch {}
    try { await member.kick('にゅうこくしっぱい'); } catch {}
}

async function successAuth(member, session) {
    clearInterval(session.timer);
    sessions.delete(member.id);

    await member.roles.add(CONFIG.VERIFY_ROLE_ID).catch(() => {});
    await logSuccess(member);

    const channel = member.guild.channels.cache.get(CONFIG.WELCOME_CHANNEL_ID)
        || member.guild.channels.cache.get(CONFIG.AUTH_CHANNEL_ID);

    if (!channel) return;

    const welcomeEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🎉 ネバーランドへようこそ！')
        .setDescription(
            `${member} がなかまになったよ！\n` +
            `みんなでなかよくしてね 🌟`
        );
    if (assetUrls.logo) welcomeEmbed.setThumbnail(assetUrls.logo);
    if (assetUrls.bg) welcomeEmbed.setImage(assetUrls.bg);
    await channel.send({ embeds: [welcomeEmbed] });
}

/* ===== イベント ===== */

async function onMemberAdd(member) {
    if (member.user.bot) return;

    if (whitelist.includes(member.id)) {
        await member.roles.add(CONFIG.VIP_ROLE_ID).catch(() => {});
        return;
    }

    if (authPaused) {
        await member.roles.add(CONFIG.VERIFY_ROLE_ID).catch(() => {});
        console.log(`[AUTH PAUSE] ${member.user.tag}(${member.id}) 認証スキップで入国`);
        return;
    }

    await startAuth(member);
}

function onMemberRemove(member) {
    const session = sessions.get(member.id);
    if (session) {
        clearInterval(session.timer);
        sessions.delete(member.id);
    }
}

async function onInteraction(interaction) {
    if (!interaction.isButton()) return false;

    // 「認証する」ボタン（!authpanel で設置）→ 呪文認証を開始する
    if (interaction.customId === 'start_auth') {
        const member = interaction.member;
        if (member.roles.cache.has(CONFIG.VERIFY_ROLE_ID) || whitelist.includes(member.id)) {
            await interaction.reply({ content: '✅ もう認証済みだよ！', ephemeral: true });
            return true;
        }
        const existing = sessions.get(member.id);
        if (existing) {
            await interaction.reply({ content: '🔑 すでに認証中だよ。にゅうこくしんさスレッドをみてね。', ephemeral: true });
            return true;
        }
        await interaction.reply({ content: '🔑 にゅうこくしんさスレッドをつくったよ！そちらをみてね。', ephemeral: true });
        startAuth(member).catch((err) => console.error('startAuth(button) failed', err));
        return true;
    }

    if (!interaction.customId.startsWith('numsel_')) return false;

    const session = sessions.get(interaction.user.id);
    if (!session || session.step !== 1) {
        await interaction.reply({ content: 'セッションがみつからないよ。もういちどためしてね。', ephemeral: true });
        return true;
    }

    const selected = Number(interaction.customId.split('_')[1]);

    if (selected !== session.number) {
        await interaction.reply({ content: 'ばんごうがちがうよ💦', ephemeral: true });
        await failAuth(interaction.member, session, 'wrong');
        return true;
    }

    session.step = 2;

    await interaction.update({
        embeds: [buildStep2Embed(session.phrase, session.timeLeft)],
        components: [],
    });
    return true;
}

// 認証メッセージ判定（ステップ2：おまじないの入力）
async function onMessage(message) {
    const session = sessions.get(message.author.id);
    if (!session || session.step !== 2) return;
    if (message.channel.id !== session.thread.id) return;

    const normalize = (s) => s
        .trim()
        .normalize('NFC')
        .replace(/[​-‍﻿︀-️]/g, '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ');
    if (normalize(message.content) === normalize(session.phrase)) {
        await successAuth(message.member, session);
    } else {
        await failAuth(message.member, session, 'wrong');
    }
}

/* ===== コマンド ===== */

// 手動再認証
async function reauthCommand(message) {
    const target = message.mentions.members?.first();
    if (!target) {
        return message.reply('対象ユーザーをメンションしてね。例: `!reauth @ユーザー`');
    }

    // 既存セッションがあればクリア
    const existing = sessions.get(target.id);
    if (existing) {
        clearInterval(existing.timer);
        try { await existing.thread.setArchived(true); } catch {}
        sessions.delete(target.id);
    }

    await startAuth(target);
    await message.reply(`${target} の再認証をはじめたよ 🔑`);
}

// 認証パネル設置: 押すと呪文認証がはじまるボタンを置く
async function authPanelCommand(message) {
    const desc = message.content.trim().slice('!authpanel'.length).trim()
        || 'したのボタンをおして、にゅうこくしんさ（おまじない認証）をはじめてね 🗝️';
    const panel = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🌙 ネバーランドのとびら')
        .setDescription(desc);
    if (assetUrls.logo) panel.setThumbnail(assetUrls.logo);
    if (assetUrls.bg) panel.setImage(assetUrls.bg);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('start_auth').setLabel('認証する').setEmoji('🔑').setStyle(ButtonStyle.Primary),
    );
    await message.channel.send({ embeds: [panel], components: [row] });
    await message.delete().catch(() => {});
}

// 顔パス
async function vipCommand(message, args) {
    const sub = args[0];
    const usage = '使い方: `!vip add @ユーザー or ID` / `!vip remove @ユーザー or ID` / `!vip list`';

    if (sub === 'list') {
        if (whitelist.length === 0) return message.reply('顔パスリストは空だよ');
        const mentions = whitelist.map(id => `<@${id}>`).join('\n');
        return message.reply(`⭐ 顔パスリスト\n${mentions}`);
    }

    // メンションまたはIDからメンバー取得（サーバー外ユーザーも許容）
    const targetId = message.mentions.members?.first()?.id ?? args[1]?.replace(/\D/g, '');
    if (!targetId) return message.reply(usage);
    const target = message.guild.members.cache.get(targetId)
        ?? await message.guild.members.fetch(targetId).catch(() => null);

    if (sub === 'add') {
        if (!whitelist.includes(targetId)) {
            whitelist.push(targetId);
            saveWhitelist(whitelist);
        }
        if (target) {
            await target.roles.add(CONFIG.VIP_ROLE_ID).catch(() => {});
            return message.reply(`${target} を顔パスリストに追加したよ ⭐`);
        }
        return message.reply(`ID \`${targetId}\` を顔パスリストに追加したよ ⭐（次回入室時にVIPロール付与）`);
    }

    if (sub === 'remove') {
        whitelist = whitelist.filter(id => id !== targetId);
        saveWhitelist(whitelist);
        return message.reply(target ? `${target} を顔パスリストから外したよ` : `ID \`${targetId}\` を顔パスリストから外したよ`);
    }

    return message.reply(usage);
}

// 入国審査の一時停止（メモリ上のみ。再起動で稼働中に戻る）
async function authCommand(message, args) {
    const sub = args[0];
    if (sub === 'pause') {
        authPaused = true;
        return message.reply('⏸️ 入国審査を一時停止したよ。この間に入国したユーザーは認証なしで入れるよ。解除は `!auth resume`');
    }
    if (sub === 'resume') {
        authPaused = false;
        return message.reply('▶️ 入国審査を再開したよ。');
    }
    if (sub === 'status') {
        return message.reply(authPaused ? '⏸️ 入国審査は現在**一時停止中**だよ。' : '▶️ 入国審査は現在**稼働中**だよ。');
    }
}

module.exports = {
    name: 'auth',
    enabled: () => process.env.ENABLE_AUTH === 'true',
    commands: {
        '!reauth': { admin: true, run: reauthCommand },
        '!authpanel': { admin: true, run: authPanelCommand },
        '!vip': { admin: true, run: vipCommand },
        '!auth': { admin: true, run: authCommand },
    },
    help: [
        { name: '`!reauth @ユーザー`', value: '手動で再認証を開始する' },
        { name: '`!authpanel [説明文]`', value: '押すと認証がはじまるボタンを設置する' },
        { name: '`!vip add @ユーザー`', value: '顔パスリストに追加＋認証ロール付与' },
        { name: '`!vip remove @ユーザー`', value: '顔パスリストから削除' },
        { name: '`!vip list`', value: '顔パスリストを表示' },
        { name: '`!auth pause`', value: '入国審査を一時停止（この間の入国者は認証不要）' },
        { name: '`!auth resume`', value: '入国審査を再開' },
        { name: '`!auth status`', value: '入国審査の現在の状態を確認' },
    ],
    async onReady(client) {
        await initAssets(client);
    },
    onMemberAdd,
    onMemberRemove,
    onInteraction,
    onMessage,
};

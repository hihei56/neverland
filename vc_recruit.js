// vc_recruit.js — VCが長時間無人のとき、募集ボタン付きメッセージを自動投稿する（簡略版）
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./dataPath');

const FILE = path.join(DATA_DIR, 'vc_recruit.json');

const VC_EMPTY_MS = 2 * 60 * 60 * 1000;   // VCが2時間無人になったら対象
const TEXT_ACTIVE_MS = 3 * 60 * 60 * 1000; // 直近3時間にテキストの発言がある＝サーバーが生きている
const POST_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 自動投稿の間隔
const CHECK_INTERVAL_MS = 10 * 60 * 1000;    // 10分ごとチェック
const PRESS_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 1人あたりのボタン連打制限

let lastVCActive = Date.now();
let lastText = Date.now();
let lastPosted = 0;
const pressLog = new Map(); // userId -> 最終押下時刻

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        return { channelId: null, roleId: null };
    }
}

function saveSettings(s) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
}

function setChannel(channelId) { const s = loadSettings(); s.channelId = channelId; saveSettings(s); }
function setRole(roleId) { const s = loadSettings(); s.roleId = roleId; saveSettings(s); }
function disable() { const s = loadSettings(); s.channelId = null; saveSettings(s); }

/** テキスト発言を記録（サーバーが活動中かの判定用）。 */
function recordText() { lastText = Date.now(); }

/** ギルドのVCに誰か（Bot以外）いれば「VCがまだ生きている」と記録。 */
function anyoneInVC(guild) {
    return guild.channels.cache.some((c) =>
        (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) &&
        c.members.filter((m) => !m.user.bot).size > 0);
}

function buildRecruitMessage(roleId) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔊 通話しませんか？')
        .setDescription('いまVCがしずかです。ボタンを押すと募集のよびかけをします！');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vc_recruit_ping').setLabel('通話に誘う').setEmoji('📣').setStyle(ButtonStyle.Primary),
    );
    void roleId; // 実際の呼びかけはボタン押下時に行う（自動投稿はメンションしない）
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

async function tick(client) {
    try {
        const s = loadSettings();
        if (!s.channelId) return;
        const channel = await client.channels.fetch(s.channelId).catch(() => null);
        if (!channel?.guild) return;

        if (anyoneInVC(channel.guild)) { lastVCActive = Date.now(); return; }
        const now = Date.now();
        if (now - lastVCActive < VC_EMPTY_MS) return;   // まだ無人期間が短い
        if (now - lastText > TEXT_ACTIVE_MS) return;    // サーバー自体が静か → 投稿しない
        if (now - lastPosted < POST_COOLDOWN_MS) return; // 投稿クールダウン

        await channel.send(buildRecruitMessage(s.roleId));
        lastPosted = now;
    } catch (e) {
        console.error('[VcRecruit] tick error:', e.message);
    }
}

function initVcRecruit(client) {
    const timer = setInterval(() => tick(client), CHECK_INTERVAL_MS);
    timer.unref?.();
}

/** 募集ボタン押下 → ロールメンションでよびかけ（連打はクールダウン）。 */
async function handleVcRecruitButton(interaction) {
    if (interaction.customId !== 'vc_recruit_ping') return false;
    const s = loadSettings();
    const now = Date.now();
    const last = pressLog.get(interaction.user.id) || 0;
    if (now - last < PRESS_COOLDOWN_MS) {
        await interaction.reply({ content: '⏳ さっき呼びかけたばかりだよ。しばらくしてからね。', ephemeral: true });
        return true;
    }
    pressLog.set(interaction.user.id, now);
    const mention = s.roleId ? `<@&${s.roleId}> ` : '';
    await interaction.reply({
        content: `${mention}${interaction.user} が通話に誘っています！ VCに集合しよう 🎧`,
        allowedMentions: s.roleId ? { roles: [s.roleId] } : { parse: [] },
    });
    return true;
}

/** 試し投稿（無人判定・クールダウンを無視して即投稿）。 */
async function testPost(channel) {
    await channel.send(buildRecruitMessage(loadSettings().roleId));
}

module.exports = { initVcRecruit, recordText, setChannel, setRole, disable, handleVcRecruitButton, loadSettings, testPost };

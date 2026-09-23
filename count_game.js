// count_game.js — カウントゲーム（指定チャンネルで 1,2,3... と数える。間違い/連続でリセット）
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./dataPath');

const FILE = path.join(DATA_DIR, 'count_game.json');

function load() {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        return { guilds: {} };
    }
}

function save(db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function ensureGuild(db, guildId) {
    if (!db.guilds[guildId]) db.guilds[guildId] = { channelId: null, current: 0, lastUserId: null };
    return db.guilds[guildId];
}

/** このチャンネルをカウント部屋にする（0にリセット）。 */
function setChannel(guildId, channelId) {
    const db = load();
    const g = ensureGuild(db, guildId);
    g.channelId = channelId;
    g.current = 0;
    g.lastUserId = null;
    save(db);
}

function disable(guildId) {
    const db = load();
    ensureGuild(db, guildId).channelId = null;
    save(db);
}

function status(guildId) {
    const g = load().guilds[guildId];
    return g && g.channelId ? { channelId: g.channelId, current: g.current } : null;
}

/** メッセージが数字だけなら true。 */
function parseNumber(content) {
    const s = content.trim();
    return /^\d{1,6}$/.test(s) ? parseInt(s, 10) : null;
}

async function handleCountMessage(message) {
    if (message.author.bot || !message.guild) return;
    const db = load();
    const g = db.guilds[message.guild.id];
    if (!g || !g.channelId || message.channel.id !== g.channelId) return;

    const n = parseNumber(message.content || '');
    if (n === null) return; // 数字以外は無視（リセットしない）

    const expected = g.current + 1;
    const sameUser = message.author.id === g.lastUserId;

    if (n === expected && !sameUser) {
        g.current = expected;
        g.lastUserId = message.author.id;
        save(db);
        await message.react('✅').catch(() => {});
        return;
    }

    // 失敗 → リセット
    g.current = 0;
    g.lastUserId = null;
    save(db);
    await message.react('❌').catch(() => {});
    const reason = sameUser ? '同じ人が連続はダメ' : `${expected} を入れてね`;
    await message.channel.send(`💥 ${message.author} が失敗！（${reason}）カウントは 0 に戻りました。次は **1** から！`)
        .catch(() => {});
}

module.exports = { setChannel, disable, status, handleCountMessage };

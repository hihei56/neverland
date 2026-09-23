// shiritori.js — しりとりゲーム（kuromoji.jsでかな変換・辞書判定）
const { EmbedBuilder } = require('discord.js');
const { getSettings, saveSettings } = require('./shiritori_settings');
const { getTokenizer } = require('./japanese_tokenizer');

const HISTORY_LIMIT = 200;

// 単語として扱う上限文字数。長文を投げつけるスパム対策（正規の単語はまず超えない）
const MAX_WORD_LENGTH = 20;

const SMALL_TO_LARGE = {
    'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お',
    'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'っ': 'つ', 'ゎ': 'わ',
};

const gameState = new Map(); // channelId -> { currentWord: {surface, reading, last} | null, history: Set<string> }
const webhookCache = new Map();

function initShiritori() {
    getTokenizer()
        .then(() => console.log('[Shiritori] ✅ 辞書ロード完了'))
        .catch(e => console.error('[Shiritori] 辞書ロード失敗:', e.message));
}

async function getWebhook(channel, client) {
    const targetChannel = channel.isThread() ? channel.parent : channel;
    if (webhookCache.has(targetChannel.id)) return webhookCache.get(targetChannel.id);
    const hooks = await targetChannel.fetchWebhooks();
    let wh = hooks.find(h => h.owner?.id === client.user.id && h.token);
    if (!wh) wh = await targetChannel.createWebhook({ name: 'しりとり', avatar: client.user.displayAvatarURL() });
    webhookCache.set(targetChannel.id, wh);
    return wh;
}

async function sendViaWebhook(message, embed) {
    try {
        const webhook = await getWebhook(message.channel, message.client);
        await webhook.send({
            embeds: [embed],
            username: 'しりとり',
            avatarURL: message.client.user.displayAvatarURL(),
            allowedMentions: { parse: [] },
            ...(message.channel.isThread() && { threadId: message.channel.id }),
        });
    } catch (e) {
        console.error('[Shiritori] Webhook送信エラー:', e.message);
    }
}

function katakanaToHiragana(str) {
    return str.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// 辞書に存在するかは問わず、読みの推定だけ行う（VTuber名や固有名詞なども対象にするため）
async function analyzeWord(surface) {
    // ひらがな/カタカナのみで構成される場合は形態素解析を経由せずそのまま読みとして扱う
    if (/^[ぁ-んァ-ヶー]+$/.test(surface)) {
        return { reading: katakanaToHiragana(surface) };
    }
    const tokenizer = await getTokenizer();
    const tokens = tokenizer.tokenize(surface);
    if (tokens.length === 0) return null;
    const reading = tokens.map(t => t.reading || t.surface_form).join('');
    if (!reading) return null;
    return { reading: katakanaToHiragana(reading) };
}

// 語尾の長音符「ー」は直前の文字の母音を引き継ぐため、簡易的に除去して直前の文字を実質の語尾とする
function getReadingEdges(reading) {
    const trimmed = reading.replace(/ー+$/, '') || reading;
    const chars = [...trimmed];
    const last = SMALL_TO_LARGE[chars[chars.length - 1]] ?? chars[chars.length - 1];
    const first = SMALL_TO_LARGE[chars[0]] ?? chars[0];
    return { first, last, full: trimmed };
}

function resetShiritoriGame(channelId) {
    if (!channelId) return;
    gameState.set(channelId, { currentWord: null, history: new Set() });
}

function buildEmbed(color, description) {
    return new EmbedBuilder().setColor(color).setDescription(description);
}

async function handleShiritoriMessage(message) {
    try {
        if (message.author.bot || !message.guild) return;

        const settings = getSettings();
        const channelId = settings.shiritoriChannelId;
        if (!channelId || message.channel.id !== channelId) return;

        const surface = message.content?.trim();
        if (!surface) return;

        if ([...surface].length > MAX_WORD_LENGTH) {
            if (message.deletable) await message.delete().catch(() => {});
            await sendViaWebhook(message, buildEmbed(0xED4245, `❌ 単語は${MAX_WORD_LENGTH}文字以内で入力してください。`));
            return;
        }

        let info;
        try {
            info = await analyzeWord(surface);
        } catch (e) {
            console.error('[Shiritori] 解析エラー:', e.message);
            return;
        }

        if (!info) {
            await sendViaWebhook(message, buildEmbed(0xED4245, '❌ 読みを認識できませんでした。'));
            return;
        }

        // 読みにひらがな以外の文字（アルファベット等）が混入している場合は無効
        if (!/^[ぁ-んー]+$/.test(info.reading)) {
            await sendViaWebhook(message, buildEmbed(0xED4245, '❌ 日本語の単語を入力してください。'));
            return;
        }

        const { first, last, full } = getReadingEdges(info.reading);
        if (!full) {
            await sendViaWebhook(message, buildEmbed(0xED4245, '❌ 有効な単語として認識できませんでした。'));
            return;
        }

        let state = gameState.get(channelId);
        if (!state) {
            state = { currentWord: null, history: new Set() };
            gameState.set(channelId, state);
        }

        if (last === 'ん') {
            gameState.set(channelId, { currentWord: null, history: new Set() });
            await sendViaWebhook(message, buildEmbed(0xFEE75C, `💀 「ん」で終わったので **${message.author.username}** の負けです！しりとりをリセットしました。`));
            return;
        }

        if (state.currentWord && state.currentWord.last !== first) {
            await sendViaWebhook(message, buildEmbed(0xED4245, `❌ 前の単語の語尾「${state.currentWord.last}」から始まる言葉にしてください。`));
            return;
        }

        if (state.history.has(full)) {
            await sendViaWebhook(message, buildEmbed(0xED4245, '❌ その単語はすでに使われています。'));
            return;
        }

        state.history.add(full);
        if (state.history.size > HISTORY_LIMIT) {
            state.history.delete(state.history.values().next().value);
        }
        state.currentWord = { surface, reading: full, last };

        await sendViaWebhook(message, buildEmbed(0x57F287, `✅ **${surface}**（${full}）\n次は「${last}」から始まる言葉をどうぞ！`));
    } catch (e) {
        console.error('[Shiritori] 処理エラー:', e);
    }
}

module.exports = { initShiritori, handleShiritoriMessage, resetShiritoriGame };

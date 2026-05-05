// moderator.js
const axios  = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getModExcludeList } = require('./exclude_manager');
const whStore = require('./webhook_store');
const { isCursed } = require('./curse_manager');

const VIP_ROLE_ID = process.env.VIP_ROLE_ID;
if (!VIP_ROLE_ID) console.warn('[MOD] VIP_ROLE_ID が .env に設定されていません。moderator は動作しません。');

const EXEMPT_ROLES = [
    '1486178659130933278',
    '1477024387524857988',
];
// moderatorはVIPロールのみ対象
const REQUIRED_ROLES = [VIP_ROLE_ID].filter(Boolean);

const SENSITIVE_ALLOWED_ROLES = [
    '1486178659130933278',
    '1477024387524857988',
];
const ALLOWED_ROLES           = ['1476944370694488134', '1478715790575538359'];
const SENSITIVE_TRIGGER_EMOJI = '👶';
const TUPPERBOX_APP_ID        = '431544605209788416';
const TUPPERBOX_PREFIX_REGEX  = /^([a-zA-Z]+!)(.*)$/;

const ZERO_WIDTH_MAP     = { '0': '​', '1': '‌' };
const REVERSE_ZERO_WIDTH = { '​': '0', '‌': '1' };

function hideUserId(userId) {
    return [...BigInt(userId).toString(2)].map(b => ZERO_WIDTH_MAP[b]).join('');
}

function extractUserId(text) {
    if (!text) return null;
    const bits = [...text].filter(c => REVERSE_ZERO_WIDTH[c]).map(c => REVERSE_ZERO_WIDTH[c]).join('');
    if (!bits) return null;
    try { return BigInt('0b' + bits).toString(); } catch { return null; }
}

function sanitizeMentions(text) {
    if (!text) return text;
    return text
        .replace(/@everyone/g, '@​everyone')
        .replace(/@here/g,     '@​here');
}

function hasModPermission(member) {
    if (!member) return false;
    if (member.permissions.has('Administrator')) return true;
    return ALLOWED_ROLES.some(id => member.roles.cache.has(id));
}

const spamTracker = new Map();

function checkSpam(userId) {
    const now   = Date.now();
    const times = (spamTracker.get(userId) || []).filter(t => now - t < 10_000);
    if (times.length >= 5 || (times.length >= 3 && now - times[0] < 3_000)) return true;
    times.push(now);
    spamTracker.set(userId, times);
    return false;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, times] of spamTracker) {
        if (times.every(t => now - t >= 10_000)) spamTracker.delete(id);
    }
}, 60_000);

function normalizeForDetection(text) {
    if (!text) return '';
    return text
        .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
        .replace(/[​-‏⁠⁡﻿­]/g, '')
        .toLowerCase()
        .replace(/[\s　_\-.,。、・「」『』【】〔〕《》〈〉（）()\[\]{}*★☆◆◇●○]/g, '');
}

const LOLI_SHOTA_REGEX = new RegExp([
    'ロリ','ろり','ﾛﾘ','loli',
    'ショタ','しょた','ｼｮﾀ','shota',
    'ロリコン','ろりこん','lolicon',
    'ショタコン','しょたこん','shotacon',
    '幼女','幼男','キッズ',
    '小学生','中学生','小学校','中学校',
    'ペド','ぺど',
    'p\\W*e\\W*d\\W*o',
    '小児性愛','幼児性愛','小児愛',
    'ペドフィリア','ペドフィール',
    '援交','えんこう','援助交際',
    '児童ポルノ','児童買春','児童わいせつ',
    '幼児わいせつ','幼児淫行',
    'csam',
    'child\\W*porn','child\\W*abuse\\W*mater',
    'エプスタイン','🧒','👧','👦','🍼','🎒',
    '児童','未成年',
    'ガキ','がき',
    '女児','男児','幼児',
    '乳児','乳幼児','園児','新生児',
    '女子小学生','女子中学生','じょしこうせい(?=.*(?:えっち|エッチ|性的|わいせつ))',
    'おさな(?:妻|い子)',
    '年端もいかない',
    'cp(?:画像|動画|写真)',
    'minors?\\s*(?:only|just|with|and)',
    'minor\\s*attract',
    'map(?:community|pride|flag)',
    'hebephil','ephebophil',
    '子供(?:に|と)?(?:性的|わいせつ|えっち|エッチ)',
    '少女',
    '少年(?:愛|に性的|わいせつ)',
    '児(?:ポ|童|の性|に性的|わいせつ)',
    '(?:女の子|男の子|子供|こども)(?:の)?(?:裸|ヌード|えっち|エッチ|性的|わいせつ|に手を出)',
    '子(?:の)?(?:裸|ヌード)(?:画像|写真|動画)',
    '(?:保育|幼稚)園(?:児)?(?:に性的|わいせつ|えっち|エッチ)',
    'ランドセル',
    '制服(?:えっち|エッチ|sex|ポルノ|わいせつ)',
    '体操着(?:えっち|エッチ|sex)',
    '水着(?:の子|の少女|の女児)',
    '放課後(?:えっち|エッチ|sex|わいせつ|に誘)',
    'jailbait',
    'preteen',
    'underage\\s*(?:sex|porn|nude|girl|boy)',
    'child\\s*(?:sex|sexual|molest|abuse|exploit)',
    'girl\\s*(?:next\\s*door)?\\s*(?:underage|minor)',
].join('|'), 'i');

const AGE_REGEX = new RegExp([
    '(?<![0-9０-９])(?:[0-9]|1[0-2])(?:歳|才|さい)',
    '(?<![0-9０-９])(?:[０-９]|１[０-２])(?:歳|才|さい)',
    '(?:一|二|三|四|五|六|七|八|九|十|十一|十二)(?:歳|才|さい)',
    '13歳未満','小[1-6]','中[1-3]',
    '(?<![0-9])(?:[1-9]|1[0-2])\\s*(?:yo|y\\/o|year\\W*old)',
    'u\\s*18(?![0-9])',
].join('|'), 'i');

const THREAT_REGEX = new RegExp([
    '殺','死ね','しね','死ねよ','死んでしまえ',
    '殺す','ころす','殺してやる','殺すぞ','ぶっ殺',
    '爆破','爆殺','刺す','刺してやる','刺すぞ',
    '銃(?:で撃|で殺)',
    'kill\\s*you',"i'?ll\\s*kill",'gonna\\s*kill','want\\s*(?:you\\s*)?dead',
    '自殺しろ','死んでください','死んでほしい','死んでくれ',
    'お前(?:は|が)?(?:死|消え)(?:ろ|ねよ|んでしまえ)',
    'テロ(?:を起こせ|しろ|実行)',
    '大量虐殺(?:しろ|せよ|万歳)',
    'mass\\s*shoot(?:ing)?',
    'school\\s*shoot(?:ing)?',
    '無差別(?:殺人|テロ|攻撃)(?:しろ|やれ|万歳)',
].join('|'), 'i');

const DRUG_REGEX = new RegExp([
    '覚醒剤','覚せい剤','MDM[Aa]','コカイン','ヘロイン',
    '大麻','マリファナ','危険ドラッグ','脱法ドラッグ',
    'シャブ','やく(?:を|買|売|やる)',
    'drug\\s*deal','sell\\s*drug',
].join('|'), 'i');

const SELF_HARM_PROMO_REGEX = new RegExp([
    '首吊り(?:方法|やり方|場所|ひも|紐|ロープ|のしかた)',
    '首を吊る(?:方法|やり方)',
    '飛び降り(?:方法|やり方|場所|名所|スポット)',
    '飛び降りる(?:場所|方法)',
    '自殺(?:方法|のやり方|のしかた|の仕方|名所|スポット|する方法|したい|しようかな|を考え|について教)',
    '死に方(?:を教|教えて|知りたい)',
    '楽に死ぬ(?:方法|には|方)',
    '安楽死(?:方法|のやり方)',
    'od(?:の仕方|やり方|方法|量|して死)',
    '睡眠薬(?:で死|を飲んで死)',
    '過剰摂取(?:の量|方法|のやり方)',
    'リストカット(?:の仕方|方法|やり方)',
    'リスカ(?:の仕方|方法)',
    '練炭自殺',
    '入水自殺(?:場所|方法)',
    '焼身自殺(?:の仕方|方法)',
    '電車(?:に飛び込む|で自殺)(?:方法|場所)',
    '(?:もう)?死(?:にたい|のう|んでしまいたい|にたくなった)',
    '生きていたくない',
    '生きてる意味(?:がない|ない|わからない)',
    '消えてしまいたい',
    'suicide(?:\\s*method|\\s*how|\\s*spot|\\s*note|\\s*bridge)',
    'how\\s*to\\s*(?:kill\\s*myself|commit\\s*suicide|end\\s*(?:my\\s*)?life)',
].join('|'), 'i');

const HATE_REGEX = new RegExp([
    'チャンコロ','チョンコ',
    'チョン(?:め|野郎|は死ね|出て行け|ども)',
    '支那(?:人め|め|野郎|女め|人)',
    '(?:外国人|移民|難民|在日)(?:は|を)?(?:出て(?:いけ|行け|ろ)|追い出せ|帰れ(?:よ|！|$)|殺せ)',
    '(?:ゴキブリ|害虫|寄生虫|ウジ虫|ゴミ)(?:外国人|移民|在日|黒人|朝鮮人|韓国人|中国人)',
    '(?:外国人|移民|在日|黒人|朝鮮人|韓国人|中国人)(?:ゴキブリ|害虫|寄生虫|ウジ虫|ゴミ)',
    '(?:ムスリム|イスラム|ユダヤ|LGBT|障害者|黒人|外国人)(?:は)?(?:消えろ|いなくなれ|死ね|殺せ|根絶やし)',
    '(?:人種|民族|外国人)(?:を)?(?:浄化|根絶|駆逐)',
    '生きるに値しない命',
    '生きる価値(?:の)?ない(?:命|人間|存在)',
    '(?:障害者|精神障害者|知的障害者)(?:は)?(?:生きる価値がない|社会のお荷物|不要な存在)',
    'nigger','nigga','n\\s*[-_]\\s*word','ニガー',
    '黒人(?:は|が|を|め|野郎|ども)?(?:死ね|消えろ|ゴミ|クズ|猿|バカ|出て行け|帰れ|嫌い)',
    'kike',
    'ユダヤ(?:の陰謀|が世界を支配|人め|人野郎|人を殺|人は出て行け)',
    'ホロコースト(?:は嘘|なかった|否定|でたらめ)',
    'holocaust\\s*(?:denial|lie|fake|hoax|didn)',
    'antisemit',
    'white\\s*(?:power|supremac|nationalist|genocide)',
    'heil\\s*hitler','ハイル\\s*ヒトラー',
    'ナチス(?:万歳|最高|を支持|賛美|正しい|復活)',
    '14\\s*words',
    'chink','チンク','gook',
    '(?:朝鮮|韓国)人(?:は)?(?:ゴキブリ|害虫|寄生虫|猿|死ね|消えろ|出て行け)',
    '(?:中国|シナ)人(?:は)?(?:ゴキブリ|害虫|寄生虫|猿|死ね|消えろ)',
    'towelhead','raghead','sand\\s*n(?:igger|igga)','camel\\s*jockey',
    'ethnic\\s*cleansing','race\\s*(?:war|traitor)',
    '(?:民族|人種)(?:の)?浄化',
    '(?:外国人|移民)(?:排斥|根絶|駆逐)(?:せよ|しろ|万歳)',
    '売国(?:奴|者)',
    'spic','beaner','wetback','slope','zipperhead','curry\\s*(?:muncher|nigger)','paki',
].join('|'), 'i');

const DISABILITY_HATE_REGEX = new RegExp([
    'かたわ','びっこ','めくら','つんぼ','いざり',
    '知恵遅れ','ガイジ','ハッタショ','アスペ',
    'スペ(?:め|かよ|すぎ|だろ|だな|ども)',
    'キチガイ','きちがい','基地外',
    'メンヘラ(?:死ね|消えろ|うざ)',
    '精神異常(?:者め|者は)',
    'キ○ガイ','キ◯ガイ',
    'retard(?:ed)?','spastic',
    'mental(?:ly)?\\s*(?:ill\\s*(?:freak|scum)|retard)',
].join('|'), 'i');

function checkNgWords(text) {
    const matched = [];
    function testAndCapture(regex, label) {
        const m = text.match(regex);
        if (m) matched.push(`${label}(${m[0].slice(0, 20)})`);
    }
    testAndCapture(LOLI_SHOTA_REGEX,     'loli_shota');
    testAndCapture(AGE_REGEX,            'age');
    testAndCapture(THREAT_REGEX,         'threat');
    testAndCapture(DRUG_REGEX,           'drug');
    testAndCapture(SELF_HARM_PROMO_REGEX,'self_harm_promo');
    testAndCapture(HATE_REGEX,           'hate_speech');
    testAndCapture(DISABILITY_HATE_REGEX,'disability_hate');
    return { hit: matched.length > 0, matched };
}

const DL_CONFIG = { MAX_FILES: 4, MAX_SIZE: 8 * 1024 * 1024, TIMEOUT: 4_000 };

async function downloadFiles(attachments) {
    const files = [];
    for (const att of [...attachments.values()].slice(0, DL_CONFIG.MAX_FILES)) {
        if (att.size > DL_CONFIG.MAX_SIZE) continue;
        try {
            const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: DL_CONFIG.TIMEOUT });
            files.push({ attachment: Buffer.from(res.data), name: att.name || 'file' });
        } catch {}
    }
    return files;
}


function logDeletion({ message, matched }) {
    const ts      = new Date().toISOString();
    const tag     = message.author.tag;
    const userId  = message.author.id;
    const channel = message.channel.name ?? message.channelId;
    const preview = (message.content ?? '').slice(0, 200).replace(/\n/g, ' ');
    console.warn(`[MOD] ${ts} | #${channel} | ${tag}(${userId}) | matched=${JSON.stringify(matched)} | "${preview}"`);
}

function stripTupperPrefix(content) {
    if (!content) return content;
    const m = content.match(TUPPERBOX_PREFIX_REGEX);
    return m ? m[2].trim() : content;
}

function recodeText(text) {
    if (!text) return '';
    let c = text;
    c = c.replace(/^@(?:\[[^\]]+\]\s*)?[^\s]+\s*/, '');
    [/ら?警察いた/g, /警察/g, /🚓/g].forEach(p => (c = c.replace(p, '')));
    return c.trim();
}

const webhookCache    = new Map();
const webhookPromises = new Map();

async function getOrCreateWebhook(channel) {
    const target = channel.isThread() ? channel.parent : channel;
    if (!target) return null;
    const key = target.id;

    const cached = webhookCache.get(key);
    if (cached) return cached.wh;

    if (webhookPromises.has(key)) return webhookPromises.get(key);

    const promise = (async () => {
        const stored = whStore.get(key);
        if (stored) { webhookCache.set(key, { wh: stored }); return stored; }

        try {
            const hooks = await target.fetchWebhooks();
            let wh = hooks.find(h => h.token);
            if (!wh) wh = await target.createWebhook({ name: 'Moderator' });
            whStore.set(key, wh);
            webhookCache.set(key, { wh });
            return wh;
        } catch (e) {
            console.error(`[Webhook] 取得失敗: ${e.message}`);
            return null;
        }
    })();

    webhookPromises.set(key, promise);
    promise.finally(() => webhookPromises.delete(key));
    return promise;
}

function invalidateWebhook(channelId) {
    webhookCache.delete(channelId);
    whStore.remove(channelId);
}

async function sendWebhook(channel, options) {
    const target = channel.isThread() ? channel.parent : channel;
    const key    = target?.id;
    const NET_DELAYS = [1_000, 3_000, 8_000];

    for (let attempt = 0; attempt <= NET_DELAYS.length; attempt++) {
        const wh = await getOrCreateWebhook(channel);
        if (!wh) return null;
        try {
            return await wh.send(options);
        } catch (e) {
            const isWebhookGone = e.status === 404 || e.code === 10015;
            if (isWebhookGone) {
                if (key) invalidateWebhook(key);
                const newWh = await getOrCreateWebhook(channel);
                if (!newWh) return null;
                try { return await newWh.send(options); }
                catch (e2) { console.error(`[Webhook] 再作成後も失敗: ${e2.message}`); return null; }
            }
            if (key) webhookCache.delete(key);
            const isLast = attempt === NET_DELAYS.length;
            if (isLast) { console.error(`[Webhook] 投稿失敗（全リトライ消化）: ${e.message}`); return null; }
            await new Promise(r => setTimeout(r, NET_DELAYS[attempt]));
        }
    }
}

async function buildReplyPrefix(message) {
    if (!message.reference?.messageId) return '';
    try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        let targetId = ref.author.id;
        if (ref.webhookId) {
            const extracted = extractUserId(ref.content);
            if (extracted) targetId = extracted;
        }
        let body = [...(ref.content || '')].filter(c => !REVERSE_ZERO_WIDTH[c]).join('').trim();
        if (ref.webhookId) {
            const lines = body.split('\n');
            const firstNonQuote = lines.findIndex(l => !l.startsWith('>'));
            if (firstNonQuote > 0) body = lines.slice(firstNonQuote).join('\n').trim();
            else if (lines[0]?.startsWith('[Reply to:]')) body = lines.slice(2).join('\n').trim();
        }
        const preview = body.length > 80 ? body.substring(0, 77).replace(/\n/g, ' ') + '...' : body.replace(/\n/g, ' ');
        const channelId = ref.channelId ?? message.channelId;
        const jumpUrl   = `https://discord.com/channels/${message.guildId}/${channelId}/${ref.id}`;
        return `> [Reply to:](${jumpUrl}) <@${targetId}>\n> ${preview}\n`;
    } catch { return ''; }
}

async function handlePseudoReply(message) {
    if (!hasModPermission(message.member)) return false;
    if (!message.reference?.messageId)     return false;

    let ref;
    try { ref = await message.channel.messages.fetch(message.reference.messageId); }
    catch { return false; }

    if (!ref.webhookId || ref.applicationId === TUPPERBOX_APP_ID) return false;
    if (!extractUserId(ref.content)) return false;

    if (message.deletable) await message.delete().catch(() => {});

    const replyPrefix  = await buildReplyPrefix(message);
    const replyContent = hideUserId(message.author.id) + sanitizeMentions(`${replyPrefix}${recodeText(message.content)}`);

    const opts = {
        content:         replyContent,
        files:           [],
        username:        message.member?.displayName || message.author.username,
        avatarURL:       message.member?.displayAvatarURL({ dynamic: true }),
        allowedMentions: { parse: ['users'] },
    };
    if (message.channel.isThread()) opts.threadId = message.channel.id;

    await sendWebhook(message.channel, opts);
    return true;
}

async function handleSensitivePost(message) {
    const hasPerm = SENSITIVE_ALLOWED_ROLES.some(id => message.member?.roles.cache.has(id));
    if (!hasPerm) return false;

    const hasTrigger = message.content?.includes(SENSITIVE_TRIGGER_EMOJI);
    const hasAttach  = message.attachments.size > 0;
    if (!hasTrigger || !hasAttach) return false;

    const files = [...message.attachments.values()].map(att => ({
        attachment: att.url,
        name:       `SPOILER_${att.name || 'image.png'}`,
    }));

    if (message.deletable) await message.delete().catch(() => {});

    const cleanContent = (message.content || '').replace(SENSITIVE_TRIGGER_EMOJI, '').trim();
    const opts = {
        content:         hideUserId(message.author.id) + sanitizeMentions(cleanContent || '​'),
        files,
        components:      [buildDeleteButtonRow(message.author.id)],
        username:        message.member?.displayName || message.author.username,
        avatarURL:       message.member?.displayAvatarURL({ dynamic: true }),
        allowedMentions: { parse: ['users'] },
    };
    if (message.channel.isThread()) opts.threadId = message.channel.id;

    await sendWebhook(message.channel, opts);
    return true;
}

async function instantDeleteAndRecode(message) {
    const files = await downloadFiles(message.attachments);
    if (message.deletable) await message.delete().catch(() => {});

    const replyPrefix  = await buildReplyPrefix(message);
    const finalContent = hideUserId(message.author.id) + sanitizeMentions(`${replyPrefix}${message.content || '​'}`);

    const opts = {
        content:         finalContent,
        files,
        components:      hasImageAttachment(message.attachments) ? [buildDeleteButtonRow(message.author.id)] : [],
        username:        message.member?.displayName || message.author.username,
        avatarURL:       message.member?.displayAvatarURL({ dynamic: true }),
        allowedMentions: { parse: ['users'] },
    };
    if (message.channel.isThread()) opts.threadId = message.channel.id;

    await sendWebhook(message.channel, opts);
}

const IMAGE_MIME_RE = /^image\//;

function hasImageAttachment(attachments) {
    return [...attachments.values()].some(a => IMAGE_MIME_RE.test(a.contentType ?? ''));
}

function buildDeleteButtonRow(authorId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`del_img:${authorId}`)
            .setLabel('削除')
            .setStyle(ButtonStyle.Danger),
    );
}

async function handleImageDeleteButton(interaction) {
    const authorId = interaction.customId.split(':')[1];
    if (interaction.user.id !== authorId) {
        return interaction.reply({ content: '削除できるのは投稿者本人のみです。', ephemeral: true });
    }
    await interaction.deferUpdate().catch(() => {});
    await interaction.deleteReply().catch(() => {});
}

const CORRUPT_CHARS = 'ﾊﾋﾌﾍﾎﾄｱｲｳｴｵｦｧｭｮｯｰｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ░▒▓│┤╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀';
const ZALGO_MARKS  = [...'̴̷̸̡̢̨̧̛̍̎̄̅̿̑̒̓̔̽̾̈́͐͑͒͗͛ͅ'];

function garbleText(text, rate) {
    const r = rate ?? (0.30 + Math.random() * 0.10);
    return [...text].map(c => {
        if (c === '\n') return c;
        const roll = Math.random();
        if (roll < r) return CORRUPT_CHARS[Math.floor(Math.random() * CORRUPT_CHARS.length)];
        if (roll < r + 0.12) {
            const n = Math.floor(Math.random() * 3) + 1;
            return c + ZALGO_MARKS.slice(0, n).join('');
        }
        return c;
    }).join('');
}

function garbleName(name) { return garbleText(name, 0.50); }

async function applyCurse(message) {
    const files = await downloadFiles(message.attachments);
    if (message.deletable) await message.delete().catch(() => {});

    const garbledContent = garbleText(sanitizeMentions(message.content || '​'));
    const garbledName    = garbleName(message.member?.displayName || message.author.username);
    const avatarURL      = message.member?.displayAvatarURL({ dynamic: true, size: 16 }) ?? undefined;
    const replyPrefix    = await buildReplyPrefix(message);

    const opts = {
        content:         hideUserId(message.author.id) + replyPrefix + garbledContent,
        files,
        username:        garbledName,
        avatarURL,
        allowedMentions: { parse: [] },
    };
    if (message.channel.isThread()) opts.threadId = message.channel.id;

    await sendWebhook(message.channel, opts);
    console.info(`[CURSE] ${message.author.tag}(${message.author.id}) メッセージを文字化け再投稿`);
}

async function handleModerator(message) {
    if (!message.content && !message.attachments.size) return;
    if (message.author.bot) return;

    const hasRequiredRole = REQUIRED_ROLES.length > 0 && REQUIRED_ROLES.some(id => message.member?.roles.cache.has(id));
    if (!hasRequiredRole) return;

    const rawContent = message.content || '';
    if (TUPPERBOX_PREFIX_REGEX.test(rawContent)) return;

    if (checkSpam(message.author.id)) {
        console.warn(`[MOD SPAM] ${message.author.tag}`);
        await message.delete().catch(() => {});
        return;
    }

    const excl     = getModExcludeList();
    const isExempt =
        EXEMPT_ROLES.some(id => message.member?.roles.cache.has(id)) ||
        excl.users.includes(message.author.id) ||
        excl.roles.some(roleId => message.member?.roles.cache.has(roleId));

    const strippedContent  = stripTupperPrefix(rawContent);
    const normalized       = normalizeForDetection(strippedContent);
    const { hit, matched } = checkNgWords(normalized);

    if (hit && !isExempt) {
        logDeletion({ message, matched });
        await instantDeleteAndRecode(message);
        return;
    }

    if (isCursed(message.author.id) && !isExempt) {
        await applyCurse(message);
        return;
    }

    if (await handleSensitivePost(message)) return;
    if (await handlePseudoReply(message))   return;
}

module.exports = { handleModerator, handleImageDeleteButton };

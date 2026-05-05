// Neverland Authentication Bot
// Private thread version + Logging + Reauth command

require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');
const fs = require('fs');
const { DATA_DIR, WHITELIST } = require('./dataPath');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
});

const CONFIG = {
    VERIFY_ROLE_ID: process.env.VERIFY_ROLE_ID,
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

function buildStep1Embed(member, number, timeLeft) {
    return new EmbedBuilder()
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
}

function buildStep2Embed(phrase, timeLeft) {
    return new EmbedBuilder()
        .setColor(getColor(timeLeft))
        .setTitle('✨ ふるいことばのちかい')
        .setDescription(
            'したのことばをそのままコピーして、このスレッドにおくってね 📜\n' +
            'むずかしくないよ、コピペするだけ！'
        )
        .addFields(
            { name: '🪄 おまじないのことば', value: `\`\`\`${phrase}\`\`\`` },
            {
                name: '⏳ のこりじかん',
                value: `${getProgressBar(timeLeft, CONFIG.LIMIT_SECONDS)} ${timeLeft}びょう`,
            }
        )
        .setFooter({ text: 'そのままコピペしてね！かえちゃダメだよ 🌟' });
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
        embeds: [buildStep1Embed(member, number, CONFIG.LIMIT_SECONDS)],
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
                        ? buildStep1Embed(member, s.number, s.timeLeft)
                        : buildStep2Embed(s.phrase, s.timeLeft),
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

    try { await session.thread.setArchived(true); } catch {}
    try { await member.kick('にゅうこくしっぱい'); } catch {}
}

async function successAuth(member, session) {
    clearInterval(session.timer);
    sessions.delete(member.id);

    await member.roles.add(CONFIG.VERIFY_ROLE_ID).catch(() => {});
    await logSuccess(member);

    try { await session.thread.setArchived(true); } catch {}

    const channel = member.guild.channels.cache.get(CONFIG.WELCOME_CHANNEL_ID)
        || member.guild.channels.cache.get(CONFIG.AUTH_CHANNEL_ID);

    if (!channel) return;

    await channel.send({
        embeds: [
            new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('🎉 ネバーランドへようこそ！')
                .setDescription(
                    `${member} がなかまになったよ！\n` +
                    `みんなでなかよくしてね 🌟`
                ),
        ],
    });
}

client.on('guildMemberAdd', async (member) => {
    if (member.user.bot) return;

    if (whitelist.includes(member.id)) {
        await member.roles.add(CONFIG.VERIFY_ROLE_ID).catch(() => {});
        return;
    }

    await startAuth(member);
});

client.on('guildMemberRemove', (member) => {
    const session = sessions.get(member.id);
    if (session) {
        clearInterval(session.timer);
        sessions.delete(member.id);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith('numsel_')) return;

    const session = sessions.get(interaction.user.id);
    if (!session || session.step !== 1) {
        return interaction.reply({ content: 'セッションがみつからないよ。もういちどためしてね。', ephemeral: true });
    }

    const selected = Number(interaction.customId.split('_')[1]);

    if (selected !== session.number) {
        await interaction.reply({ content: 'ばんごうがちがうよ💦', ephemeral: true });
        return failAuth(interaction.member, session, 'wrong');
    }

    session.step = 2;

    await interaction.update({
        embeds: [buildStep2Embed(session.phrase, session.timeLeft)],
        components: [],
    });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // 手動再認証コマンド（管理者のみ）
    if (message.content.startsWith('!reauth')) {
        if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

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
        return;
    }

    // 認証メッセージ判定
    const session = sessions.get(message.author.id);
    if (!session || session.step !== 2) return;
    if (message.channel.id !== session.thread.id) return;

    const normalize = (s) => s.trim().normalize('NFC').replace(/\s+/g, ' ');
    if (normalize(message.content) === normalize(session.phrase)) {
        await successAuth(message.member, session);
    } else {
        await failAuth(message.member, session, 'wrong');
    }
});

client.once('ready', () => {
    console.log(`${client.user.tag} きどうしたよ！`);
});

client.login(process.env.DISCORD_TOKEN);

// Neverland Bot — 起動と、各機能（features/）へのイベント振り分けだけを行う
//
// 機能モジュールの形（すべて省略可）:
//   name                      機能名（ログ用）
//   enabled()                 false なら読み込まない（例: auth は ENABLE_AUTH=true のときだけ）
//   commands                  { '!cmd': { admin: true, run(message, args) } }
//   slashCommands             SlashCommandBuilder の配列（起動時に各サーバーへ登録）
//   help                      !help に出す [{ name, value }]
//   onReady(client)           起動時
//   onMessageEarly(message)   コマンド判定より先に全メッセージで実行（モデレーション用）
//   onMessage(message)        コマンド以外のメッセージで実行（ゲーム進行など）
//   onInteraction(i)          自分が処理したら true を返す
//   onMemberAdd(member) / onMemberRemove(member)
//   onVoiceStateUpdate(oldState, newState)
//
// 新しい機能は features/<名前>/index.js を作って ALL_FEATURES に足す。

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { parseCommand, isAdmin } = require('./lib/command');

const ALL_FEATURES = [
    require('./features/moderation'),
    require('./features/auth'),
    require('./features/shiritori'),
    require('./features/count'),
    require('./features/vc_recruit'),
    require('./features/voice_panel'),
];

const features = ALL_FEATURES.filter((f) => (f.enabled ? f.enabled() : true));

// コマンド名 → { feature, admin, run }
const commands = new Map();
for (const f of features) {
    for (const [name, def] of Object.entries(f.commands || {})) {
        if (commands.has(name)) throw new Error(`コマンド ${name} が ${commands.get(name).feature} と ${f.name} で重複しています`);
        commands.set(name, { feature: f.name, admin: def.admin !== false, run: def.run });
    }
}

const HELP_COMMAND = { name: '`!help`', value: 'このヘルプを表示' };

async function helpCommand(message) {
    const fields = [...features.flatMap((f) => f.help || []), HELP_COMMAND];
    return message.reply({ embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📖 コマンド一覧')
        .addFields(fields.slice(0, 25))] });
}
commands.set('!help', { feature: 'core', admin: true, run: helpCommand });

/**
 * スラッシュコマンドを参加中の全サーバーに登録する（サーバー単位なので即反映）。
 * set() は全置き換えなので、このBotのコマンドは必ずここ（各機能の slashCommands）で定義すること。
 */
async function registerSlashCommands(c) {
    const defs = features.flatMap((f) => f.slashCommands || []).map((b) => b.toJSON());
    for (const guild of c.guilds.cache.values()) {
        try {
            await guild.commands.set(defs);
        } catch (err) {
            console.error(`[core] スラッシュコマンド登録失敗 (${guild.name}):`, err.message);
        }
    }
}

/** 各機能のハンドラを順に呼ぶ。1つが落ちても他は続行する。 */
async function each(hook, ...args) {
    for (const f of features) {
        if (!f[hook]) continue;
        try {
            await f[hook](...args);
        } catch (err) {
            console.error(`[${f.name}] ${hook} failed:`, err);
        }
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

client.on('guildMemberAdd', (member) => each('onMemberAdd', member));
client.on('guildMemberRemove', (member) => each('onMemberRemove', member));
client.on('voiceStateUpdate', (oldState, newState) => each('onVoiceStateUpdate', oldState, newState));

client.on('interactionCreate', async (interaction) => {
    for (const f of features) {
        if (!f.onInteraction) continue;
        try {
            if (await f.onInteraction(interaction)) return;
        } catch (err) {
            console.error(`[${f.name}] onInteraction failed:`, err);
            return;
        }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    await each('onMessageEarly', message);

    if (message.content.startsWith('!')) {
        const { name, args } = parseCommand(message.content);
        const cmd = commands.get(name);
        if (cmd) {
            if (cmd.admin && !isAdmin(message.member)) return;
            try {
                await cmd.run(message, args);
            } catch (err) {
                console.error(`[${cmd.feature}] ${name} failed:`, err);
            }
            return;
        }
    }

    await each('onMessage', message);
});

client.once('clientReady', async (c) => {
    console.log(`${c.user.tag} きどうしたよ！ 有効な機能: ${features.map((f) => f.name).join(', ')}`);
    await registerSlashCommands(c);
    await each('onReady', c);
});

client.login(process.env.DISCORD_TOKEN);

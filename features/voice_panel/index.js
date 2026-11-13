// features/voice_panel — 一時ボイスチャンネル（参加用VCに入ると自分の部屋ができる）＋操作パネル＋通話通知
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const vp = require('./service');
const { isAdmin } = require('../../lib/command');

const voicePanelCommand = new SlashCommandBuilder()
    .setName('voicepanel')
    .setDescription('一時ボイスチャンネル機能を設定します（管理者のみ）。')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(sub =>
        sub.setName('setup')
            .setDescription('参加用チャンネルと作成先カテゴリを設定します。')
            .addChannelOption(opt =>
                opt.setName('join_channel')
                    .setDescription('参加すると一時チャンネルが作成されるボイスチャンネル')
                    .addChannelTypes(ChannelType.GuildVoice)
                    .setRequired(true)
            )
            .addChannelOption(opt =>
                opt.setName('category')
                    .setDescription('作成先カテゴリ（省略時は参加用チャンネルと同じカテゴリ）')
                    .addChannelTypes(ChannelType.GuildCategory)
            )
    )
    .addSubcommand(sub =>
        sub.setName('panel')
            .setDescription('一時ボイスチャンネルのチャット内で、消えたパネルを再送信します。')
    )
    .addSubcommand(sub =>
        sub.setName('notify')
            .setDescription('一時ボイスチャンネルの通話継続通知を設定します。')
            .addChannelOption(opt =>
                opt.setName('channel')
                    .setDescription('通知を送信するテキストチャンネル')
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)
            )
            .addRoleOption(opt =>
                opt.setName('role')
                    .setDescription('通知時にメンションするロール（省略でメンションなし）')
            )
            .addIntegerOption(opt =>
                opt.setName('minutes')
                    .setDescription('通話継続何分で通知するか（デフォルト: 5分）')
                    .setMinValue(1)
                    .setMaxValue(180)
            )
    )
    .addSubcommand(sub =>
        sub.setName('status')
            .setDescription('現在の設定を確認します。')
    )
    .addSubcommand(sub =>
        sub.setName('serverban')
            .setDescription('一時ボイスチャンネル機能の利用（作成・参加）を禁止するユーザー/ロールを管理します。')
            .addStringOption(opt =>
                opt.setName('action')
                    .setDescription('操作を選択')
                    .setRequired(true)
                    .addChoices(
                        { name: '追加', value: 'add' },
                        { name: '解除', value: 'remove' },
                        { name: '一覧', value: 'list' },
                    )
            )
            .addUserOption(opt => opt.setName('user').setDescription('対象のユーザー（ロールと併用可）'))
            .addRoleOption(opt => opt.setName('role').setDescription('対象のロール（ユーザーと併用可）'))
    )
    .addSubcommandGroup(group =>
        group.setName('roomconfig')
            .setDescription('特定ユーザーの一時ボイスチャンネルの永続設定を管理します。')
            .addSubcommand(sub =>
                sub.setName('ban')
                    .setDescription('指定ユーザーの部屋にユーザー/ロールを出禁にします（部屋を作り直しても引き継がれます）。')
                    .addUserOption(opt => opt.setName('owner').setDescription('部屋の持ち主').setRequired(true))
                    .addUserOption(opt => opt.setName('user').setDescription('出禁にするユーザー'))
                    .addRoleOption(opt => opt.setName('role').setDescription('出禁にするロール'))
            )
            .addSubcommand(sub =>
                sub.setName('unban')
                    .setDescription('指定ユーザーの部屋の出禁を解除します。')
                    .addUserOption(opt => opt.setName('owner').setDescription('部屋の持ち主').setRequired(true))
                    .addUserOption(opt => opt.setName('user').setDescription('出禁解除するユーザー'))
                    .addRoleOption(opt => opt.setName('role').setDescription('出禁解除するロール'))
            )
            .addSubcommand(sub =>
                sub.setName('defaults')
                    .setDescription('指定ユーザーの部屋のデフォルト設定（人数制限・ロック・NSFW）を変更します。')
                    .addUserOption(opt => opt.setName('owner').setDescription('部屋の持ち主').setRequired(true))
                    .addIntegerOption(opt => opt.setName('limit').setDescription('デフォルト人数制限（0で無制限）').setMinValue(0).setMaxValue(99))
                    .addBooleanOption(opt => opt.setName('locked').setDescription('部屋を作成時に自動でロックするか'))
                    .addBooleanOption(opt => opt.setName('nsfw').setDescription('NSFW設定にするか'))
            )
            .addSubcommand(sub =>
                sub.setName('show')
                    .setDescription('指定ユーザーの部屋の永続設定を表示します。')
                    .addUserOption(opt => opt.setName('owner').setDescription('部屋の持ち主').setRequired(true))
            )
    );

async function onInteraction(i) {
    if (i.isChatInputCommand() && i.commandName === 'voicepanel') {
        // 表示は管理者限定にしてあるが、サーバー側の権限設定で開放されても実行させない
        if (!isAdmin(i.member)) {
            await i.reply({ content: 'このコマンドは管理者のみ使えます。', ephemeral: true });
            return true;
        }
        if (i.options.getSubcommandGroup(false) === null && i.options.getSubcommand() === 'serverban') {
            await vp.handleVoiceBan(i);
        } else {
            await vp.handleVoicePanel(i);
        }
        return true;
    }
    if (i.isButton() && i.customId.startsWith('vcpanel_')) {
        await vp.handleVoicePanelButton(i);
        return true;
    }
    if (i.isStringSelectMenu() && i.customId === 'vcpanel_userlimit') {
        await vp.handleVoicePanelSelect(i);
        return true;
    }
    if (i.isUserSelectMenu() && i.customId.startsWith('vcpanel_um_select_')) {
        await vp.handleVoicePanelUserSelect(i);
        return true;
    }
    if (i.isModalSubmit() && i.customId.startsWith('vcpanel_modal_')) {
        await vp.handleVoicePanelModal(i);
        return true;
    }
    return false;
}

module.exports = {
    name: 'voice_panel',
    slashCommands: [voicePanelCommand],
    help: [
        { name: '`/voicepanel setup`', value: '一時ボイスチャンネルの参加用VCと作成先カテゴリを設定' },
        { name: '`/voicepanel notify`', value: '通話がN分続いたら通知（チャンネル・ロール・分数）' },
        { name: '`/voicepanel status` / `serverban` / `roomconfig`', value: '設定確認・機能の利用禁止・部屋ごとの永続設定' },
    ],
    onReady(client) {
        vp.initVoicePanelCleanup(client);
    },
    onVoiceStateUpdate(oldState, newState) {
        return vp.handleVoicePanelVoiceState(oldState, newState);
    },
    onInteraction,
};

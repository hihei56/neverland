// features/vc_recruit — VCが長時間無人のときの募集自動投稿
const vcRecruit = require('./service');

async function vcRecruitCommand(message, args) {
    if (args[0] === 'off') {
        vcRecruit.disable();
        return message.reply('🚫 VC募集の自動投稿を無効にしたよ。');
    }
    if (args[0] === 'role') {
        const role = message.mentions.roles.first();
        if (!role) return message.reply('ロールをメンションしてね。例: `!vcrecruit role @通話勢`');
        vcRecruit.setRole(role.id);
        return message.reply(`📣 募集で呼びかけるロールを ${role} にしたよ。`);
    }
    if (args[0] === 'test') {
        await vcRecruit.testPost(message.channel);
        return;
    }
    vcRecruit.setChannel(message.channel.id);
    return message.reply('📣 このチャンネルをVC募集の投稿先にしたよ（VCが2時間無人＆サーバーが活動中のとき自動投稿）。呼びかけロールは `!vcrecruit role @ロール` で設定、テストは `!vcrecruit test`。');
}

module.exports = {
    name: 'vc_recruit',
    commands: {
        '!vcrecruit': { admin: true, run: vcRecruitCommand },
    },
    help: [
        { name: '`!vcrecruit`', value: 'VC募集の自動投稿先を設定（`role @X`/`test`/`off`）' },
    ],
    onReady(client) {
        vcRecruit.initVcRecruit(client);
    },
    // 「サーバーが活動中か」の判定用に発言時刻を記録
    onMessage() {
        vcRecruit.recordText();
    },
    async onInteraction(interaction) {
        if (!interaction.isButton() || interaction.customId !== 'vc_recruit_ping') return false;
        await vcRecruit.handleVcRecruitButton(interaction);
        return true;
    },
};

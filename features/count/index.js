// features/count — カウントゲームの設定コマンドと進行
const countGame = require('./game');
const { resolveTargetChannel, channelLabel } = require('../../lib/command');

async function countCommand(message, args) {
    if (args[0] === 'off') {
        countGame.disable(message.guild.id);
        return message.reply('🚫 カウントゲームを無効にしたよ。');
    }
    const target = resolveTargetChannel(message, args) || message.channel;
    countGame.setChannel(message.guild.id, target.id);
    return message.reply(`🔢 ${channelLabel(target, message)}をカウント部屋にしたよ！ **1** から数えてね（同じ人の連続・数え間違いでリセット）。`);
}

module.exports = {
    name: 'count',
    commands: {
        '!count': { admin: true, run: countCommand },
    },
    help: [
        { name: '`!count [#チャンネル]`', value: 'カウントゲーム部屋にする（`off`で無効）' },
    ],
    onMessage(message) {
        return countGame.handleCountMessage(message);
    },
};

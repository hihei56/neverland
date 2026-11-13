// features/shiritori — しりとり部屋の設定コマンドと進行
const { initShiritori, handleShiritoriMessage, resetShiritoriGame } = require('./game');
const { getSettings, saveSettings } = require('./settings');
const { resolveTargetChannel, channelLabel } = require('../../lib/command');

async function shiritoriCommand(message, args) {
    const settings = getSettings();
    const target = resolveTargetChannel(message, args);

    if (args[0] === 'off') {
        const id = target?.id ?? settings.shiritoriChannelId;
        settings.shiritoriChannelId = null;
        saveSettings(settings);
        if (id) resetShiritoriGame(id);
        return message.reply('🚫 しりとりを無効にしたよ。');
    }
    if (args[0] === 'reset') {
        const ch = target || message.channel;
        resetShiritoriGame(ch.id);
        return message.reply(`🔄 ${channelLabel(ch, message)}のしりとりをリセットしたよ。`);
    }
    // 引数なし → このチャンネル、指定あり → 指定チャンネルをしりとり部屋にする
    const ch = target || message.channel;
    settings.shiritoriChannelId = ch.id;
    saveSettings(settings);
    resetShiritoriGame(ch.id);
    return message.reply(`🎉 ${channelLabel(ch, message)}をしりとり部屋にしたよ！単語を送ってあそんでね（\`!shiritori off\` で無効、\`!shiritori reset\` でリセット）`);
}

module.exports = {
    name: 'shiritori',
    commands: {
        '!shiritori': { admin: true, run: shiritoriCommand },
    },
    help: [
        { name: '`!shiritori [#チャンネル]`', value: 'しりとり部屋にする（`off`で無効 / `reset`でリセット）' },
    ],
    onReady() {
        initShiritori();
    },
    // 設定チャンネル以外は game.js 側で無視される
    onMessage(message) {
        return handleShiritoriMessage(message);
    },
};

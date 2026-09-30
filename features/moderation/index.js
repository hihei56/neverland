// features/moderation — NGワード削除・画像削除ボタン等（中身は moderator.js）
const { handleModerator, handleImageDeleteButton } = require('./moderator');

module.exports = {
    name: 'moderation',

    // コマンド判定より先に、全メッセージに対して実行する
    async onMessageEarly(message) {
        await handleModerator(message);
    },

    async onInteraction(interaction) {
        if (!interaction.isButton() || !interaction.customId.startsWith('del_img:')) return false;
        await handleImageDeleteButton(interaction);
        return true;
    },
};

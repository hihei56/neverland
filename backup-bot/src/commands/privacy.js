'use strict';

const { MessageFlags } = require('discord.js');
const { privacyPolicyText } = require('../consent/privacyPolicy');
const { SNOWFLAKE } = require('../models/backup');

// 誰でも（サーバーを抜けた人もDMで）使える本人向けコマンド。すべてエフェメラル。
async function handlePrivacy(interaction, app) {
    const sub = interaction.options.getSubcommand();
    const reply = (content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (sub === 'policy') {
            const text = privacyPolicyText(app.config.privacy);
            const link = app.config.oauth.enabled ? `\n全文: ${app.config.oauth.publicBaseUrl}/privacy` : '';
            return await reply(text.slice(0, 1800) + (text.length > 1800 ? '\n…' : '') + link);
        }
        if (!app.consent) return await reply('このBotではメンバー再参加機能が無効のため、あなたの情報は保存されていません。');

        const userId = interaction.user.id;
        if (sub === 'status') {
            const list = await app.consent.status(userId);
            if (!list.length) return await reply('あなたの同意記録はありません。');
            return await reply(list.map((r) =>
                `- サーバー ${r.guildId}: ${statusLabel(r.status)}（同意日 ${r.consentedAt.slice(0, 10)}, ポリシー版 ${r.policyVersion}）`).join('\n'));
        }
        if (sub === 'optout') {
            const guildId = interaction.options.getString('guild_id');
            if (guildId && !SNOWFLAKE.test(guildId)) return await reply('guild_id の形式が不正です。');
            const n = await app.consent.optOut(userId, guildId);
            return await reply(n ? `✅ ${n} 件の同意を取り消し、トークンを失効させました。` : '取り消す同意はありませんでした。');
        }
        if (sub === 'delete') {
            if (!interaction.options.getBoolean('confirm', true)) return await reply('confirm:True を指定すると削除します。');
            const n = await app.consent.deleteAll(userId);
            return await reply(n ? '✅ あなたに関する同意記録と履歴をすべて削除しました。' : '削除するデータはありませんでした。');
        }
    } catch (err) {
        app.logger.error('privacy command failed', { sub, error: err });
        await reply('❌ 処理に失敗しました。時間をおいて再度お試しください。').catch(() => {});
    }
}

function statusLabel(s) {
    return { active: '同意中', opted_out: '取り消し済み', revoked: '連携解除済み' }[s] ?? s;
}

module.exports = { handlePrivacy };

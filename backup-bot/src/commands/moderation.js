'use strict';

const { MessageFlags } = require('discord.js');
const { requireOwnerAdmin } = require('./guard');

async function handleModeration(interaction, app) {
    if (!(await requireOwnerAdmin(interaction, app.config))) return;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const store = app.moderationStore;
    const guildId = interaction.guildId;

    try {
        if (sub === 'show') {
            const s = await store.get(guildId);
            const target = s.targetRoleIds.length ? s.targetRoleIds.map((id) => `<@&${id}>`).join(' ') : '全員（@everyone）';
            return await interaction.editReply({
                content: [
                    `**NGワード自動削除**: ${s.enabled ? '✅ 有効' : '⛔ 無効'}`,
                    `**連投スパム処罰**: ${s.spamEnabled ? '✅ 有効' : '⛔ 無効'}（削除→タイムアウト延長→キック）`,
                    `適用対象: ${target}`,
                    `NGワード数: ${s.ngWords.length}`,
                    '※ 管理者・メッセージ管理権限を持つ人は対象外です。',
                ].join('\n'),
                allowedMentions: { parse: [] },
            });
        }

        if (sub === 'toggle') {
            const enabled = interaction.options.getBoolean('enabled', true);
            await store.update(guildId, (s) => { s.enabled = enabled; });
            return await interaction.editReply(enabled ? '✅ NGワード削除を有効にしました。' : '⛔ NGワード削除を無効にしました。');
        }

        if (sub === 'spam') {
            const enabled = interaction.options.getBoolean('enabled', true);
            await store.update(guildId, (s) => { s.spamEnabled = enabled; });
            return await interaction.editReply(enabled
                ? '✅ 連投スパム処罰を有効にしました（4秒2通で連投判定→削除→段階的にタイムアウト→最終キック）。Botに「メンバーをタイムアウト」「キック」権限が必要です。'
                : '⛔ 連投スパム処罰を無効にしました。');
        }

        if (sub === 'target-add') {
            const role = interaction.options.getRole('role', true);
            if (role.id === guildId) {
                // @everyone を指定 → 全員扱い（＝対象ロール解除）
                await store.update(guildId, (s) => { s.targetRoleIds = []; });
                return await interaction.editReply('適用対象を全員（@everyone）にしました。');
            }
            const s = await store.update(guildId, (st) => {
                if (!st.targetRoleIds.includes(role.id)) st.targetRoleIds.push(role.id);
            });
            return await interaction.editReply({ content: `適用対象に追加: ${s.targetRoleIds.map((id) => `<@&${id}>`).join(' ')}`, allowedMentions: { parse: [] } });
        }

        if (sub === 'target-clear') {
            await store.update(guildId, (s) => { s.targetRoleIds = []; });
            return await interaction.editReply('適用対象を全員（@everyone）に戻しました。');
        }

        if (sub === 'ngword') {
            const action = interaction.options.getString('action', true);
            const word = (interaction.options.getString('word') || '').trim();
            if (action === 'list') {
                const s = await store.get(guildId);
                return await interaction.editReply(s.ngWords.length ? `NGワード（${s.ngWords.length}）:\n${s.ngWords.map((w) => `- \`${w}\``).join('\n')}`.slice(0, 1900) : 'NGワードは未登録です。');
            }
            if (!word) return await interaction.editReply('word を指定してください。');
            if (action === 'add') {
                const s = await store.update(guildId, (st) => { if (!st.ngWords.includes(word)) st.ngWords.push(word); });
                return await interaction.editReply(`追加しました（現在 ${s.ngWords.length} 語）。`);
            }
            if (action === 'remove') {
                const s = await store.update(guildId, (st) => { st.ngWords = st.ngWords.filter((w) => w !== word); });
                return await interaction.editReply(`削除しました（現在 ${s.ngWords.length} 語）。`);
            }
        }
    } catch (err) {
        app.logger.error('moderation command failed', { sub, error: err });
        await interaction.editReply('❌ 処理に失敗しました。').catch(() => {});
    }
}

module.exports = { handleModeration };

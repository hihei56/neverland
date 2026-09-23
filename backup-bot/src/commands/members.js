'use strict';

const crypto = require('node:crypto');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { requireOwnerAdmin, withGuildLock } = require('./guard');
const { SNOWFLAKE } = require('../models/backup');

async function handleMembers(interaction, app) {
    if (!(await requireOwnerAdmin(interaction, app.config))) return;
    if (!app.consent) {
        return interaction.reply({ content: 'メンバー再参加機能は無効です（.env の OAUTH_ENABLED=true で有効化）。', flags: MessageFlags.Ephemeral });
    }
    const sub = interaction.options.getSubcommand();

    try {
        if (sub === 'consent-link') {
            const url = `${app.config.oauth.publicBaseUrl}/consent?guild=${interaction.guildId}`;
            // 公開で案内する。強制・報酬付与はしないこと（任意の同意であることを明記）。
            return await interaction.reply({
                content: [
                    '📋 **サーバー再参加機能（任意）**',
                    'サーバーが消えてしまった場合に、新しいサーバーへ自動で再参加できるようにする機能です。',
                    '希望する人だけ、以下から内容を確認して同意してください。同意しなくても何も変わりません。',
                    url,
                    `プライバシーポリシー: ${app.config.oauth.publicBaseUrl}/privacy`,
                    '取り消しはいつでも `/privacy optout`、データ削除は `/privacy delete` でできます。',
                ].join('\n'),
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (sub === 'stats') {
            const n = await app.consent.countActive(interaction.guildId);
            return await interaction.editReply(`同意済み（有効）: ${n} 人`);
        }

        if (sub === 'rejoin') {
            const sourceGuildId = interaction.options.getString('source_guild') || interaction.guildId;
            if (!SNOWFLAKE.test(sourceGuildId) || !app.config.allowedGuildIds.includes(sourceGuildId)) {
                return await interaction.editReply('source_guild が ALLOWED_GUILD_IDS に含まれていません。');
            }
            const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
            if (!me.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
                return await interaction.editReply('Botに「招待を作成」権限が必要です（guilds.join の要件）。');
            }
            const count = await app.consent.countActive(sourceGuildId);
            const code = crypto.createHash('sha256').update(`${sourceGuildId}:${interaction.guildId}:${count}`).digest('hex').slice(0, 6).toUpperCase();
            const execute = interaction.options.getBoolean('execute') ?? false;
            const confirm = (interaction.options.getString('confirm') || '').trim().toUpperCase();

            if (!execute || confirm !== code) {
                return await interaction.editReply([
                    execute ? '⛔ 確認コードが一致しないため実行していません。' : '🔍 **dry-run**（何も変更していません）',
                    `元サーバー ${sourceGuildId} で同意済み: ${count} 人 → このサーバーへ再参加させます。`,
                    'ロールの付与は行いません。既に参加中の人はそのままです。',
                    count ? `実行: \`/members rejoin source_guild:${sourceGuildId} execute:True confirm:${code}\`` : '',
                ].filter(Boolean).join('\n'));
            }

            await interaction.editReply(`⏳ ${count} 人の再参加処理を開始します…`);
            const r = await withGuildLock(interaction.guildId, () => app.consent.rejoinMembers({
                rest: interaction.client.rest,
                queue: app.queue,
                sourceGuildId,
                targetGuildId: interaction.guildId,
            }));
            app.logger.info('rejoin completed', { sourceGuildId, targetGuildId: interaction.guildId, ...r });
            return await interaction.editReply(
                `✅ 完了: 新規参加 ${r.added} / 参加済み ${r.alreadyMember} / 連携解除済み ${r.revoked} / 失敗 ${r.failed}`,
            ).catch(() => {});
        }
    } catch (err) {
        app.logger.error('members command failed', { sub, error: err });
        const msg = `❌ エラー: ${err.message}`;
        if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
        else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

module.exports = { handleMembers };

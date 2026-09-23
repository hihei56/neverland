'use strict';

const crypto = require('node:crypto');
const { MessageFlags, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
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
            // 認証対象のサーバー（既定は現在のサーバー。別サーバーから誘導する場合は for_guild で指定）
            const targetGuildId = interaction.options.getString('for_guild') || interaction.guildId;
            if (!SNOWFLAKE.test(targetGuildId) || !app.config.allowedGuildIds.includes(targetGuildId)) {
                return await interaction.reply({ content: '⛔ for_guild が ALLOWED_GUILD_IDS に含まれていません。', flags: MessageFlags.Ephemeral });
            }
            const targetName = interaction.client.guilds.cache.get(targetGuildId)?.name || `サーバー ${targetGuildId}`;
            const title = (interaction.options.getString('title') || `${targetName} VERIFY`).slice(0, 256);
            const description = interaction.options.getString('description') || '荒らし対策用の認証です。ボタンから認証してください。';
            const useWebhook = interaction.options.getBoolean('webhook') ?? false;
            const senderName = (interaction.options.getString('sender_name') || title).slice(0, 80);
            // ボタンを押すと /oauth/start（stateを発行して即Discord認可へ）が開く。中間ページは無し。
            const url = `${app.config.oauth.publicBaseUrl}/oauth/start?guild=${targetGuildId}`;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('認証開始！').setURL(url),
            );
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(title)
                .setDescription(description)
                .setFooter({ text: `任意 ・ プライバシー: ${app.config.oauth.publicBaseUrl}/privacy` });
            // 強制・報酬付与はしないこと（任意の認証であることを明記）。

            if (useWebhook) {
                if (!interaction.channel?.isTextBased() || typeof interaction.channel.createWebhook !== 'function') {
                    return await interaction.reply({ content: '⛔ このチャンネルでは Webhook を作成できません。', flags: MessageFlags.Ephemeral });
                }
                const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
                if (!me.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
                    return await interaction.reply({ content: '⛔ Bot に「ウェブフックの管理」権限が必要です。', flags: MessageFlags.Ephemeral });
                }
                // アプリ所有の Webhook はボタン（コンポーネント）付きで送信できる。送信後に片付ける。
                const hook = await interaction.channel.createWebhook({ name: senderName, reason: '認証パネルの投稿' });
                try {
                    await hook.send({ username: senderName, embeds: [embed], components: [row], allowedMentions: { parse: [] } });
                } finally {
                    await hook.delete('認証パネル投稿後の後始末').catch(() => {});
                }
                return await interaction.reply({ content: `✅ Webhook で認証パネルを投稿しました（送信者名: ${senderName}）。`, flags: MessageFlags.Ephemeral });
            }

            return await interaction.reply({
                embeds: [embed],
                components: [row],
                allowedMentions: { parse: [] },
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (sub === 'authlog') {
            if (!app.authLogStore) return await interaction.editReply('認証ログ機能は利用できません。');
            const off = interaction.options.getBoolean('off') ?? false;
            const channel = interaction.options.getChannel('channel');
            if (off) {
                await app.authLogStore.clear(interaction.guildId);
                app.logger.info('auth log disabled', { guildId: interaction.guildId, by: interaction.user.id });
                return await interaction.editReply('🚫 認証ログを無効にしました。');
            }
            if (channel) {
                if (!channel.isTextBased?.()) return await interaction.editReply('テキストチャンネルを指定してください。');
                await app.authLogStore.set(interaction.guildId, channel.id);
                app.logger.info('auth log channel set', { guildId: interaction.guildId, channelId: channel.id, by: interaction.user.id });
                return await interaction.editReply(`✅ 認証ログを <#${channel.id}> に投稿します。`);
            }
            const current = await app.authLogStore.get(interaction.guildId);
            return await interaction.editReply(current ? `現在の認証ログ投稿先: <#${current}>` : '認証ログは未設定です（`channel:` を指定して設定）。');
        }

        if (sub === 'stats') {
            const n = await app.consent.countActive(interaction.guildId);
            return await interaction.editReply(`同意済み（有効）: ${n} 人`);
        }

        if (sub === 'info') {
            const userId = interaction.options.getString('user_id', true);
            if (!SNOWFLAKE.test(userId)) return await interaction.editReply('user_id の形式が不正です。');
            const records = await app.consent.describe(userId);
            if (!records.length) return await interaction.editReply('該当ユーザーの記録はありません。');
            const lines = [`**<@${userId}> の保存情報**（${records.length} 件）`];
            for (const r of records) {
                lines.push(
                    '',
                    `サーバー: ${r.guildId}`,
                    `状態: ${statusLabel(r.status)} / 同意: ${r.consentedAt?.slice(0, 19) ?? '-'}（版 ${r.policyVersion}）`,
                    `スコープ: ${r.scopes.join(' ') || '-'}`,
                    `トークン: ${r.hasToken ? `あり（期限 ${r.tokenExpiresAt?.slice(0, 19) ?? '?'}）` : 'なし'}`,
                );
                if (r.email != null) lines.push(`メール: ${r.email}`);
                if (r.connections?.length) lines.push(`連携: ${r.connections.map((c) => `${c.type}:${c.name}`).join(', ')}`);
                if (r.ipHash) lines.push(`IPハッシュ: ${r.ipHash}`);
            }
            lines.push('', '※ 生のトークンは表示しません（必要なら data/consents.json をサーバー上で確認）。');
            return await interaction.editReply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
        }

        if (sub === 'forget') {
            const userId = interaction.options.getString('user_id', true);
            if (!SNOWFLAKE.test(userId)) return await interaction.editReply('user_id の形式が不正です。');
            if (interaction.options.getString('confirm', true) !== userId) {
                return await interaction.editReply('確認用の入力が user_id と一致しません。削除していません。');
            }
            // 同ギルドの rejoin/export と直列化（削除中の競合を避ける）
            const removed = await withGuildLock(interaction.guildId, () => app.consent.deleteAll(userId));
            app.logger.info('member forgotten by admin', { userId, removed, by: interaction.user.id });
            return await interaction.editReply(
                removed ? `🗑️ ユーザー \`${userId}\` の同意・トークン・取得情報をすべて削除しました。` : '該当ユーザーの記録はありませんでした。',
            );
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

            const roleId = app.config.members.verifyRoleIds.get(interaction.guildId);
            if (!execute || confirm !== code) {
                return await interaction.editReply([
                    execute ? '⛔ 確認コードが一致しないため実行していません。' : '🔍 **dry-run**（何も変更していません）',
                    `元サーバー ${sourceGuildId} で同意済み: ${count} 人 → このサーバーへ再参加させます。`,
                    roleId ? `参加後に <@&${roleId}> を付与します。` : 'ロールの付与は行いません。',
                    '既に参加中の人はそのままです。',
                    count ? `実行: \`/members rejoin source_guild:${sourceGuildId} execute:True confirm:${code}\`` : '',
                ].filter(Boolean).join('\n'));
            }

            await interaction.editReply(`⏳ ${count} 人の再参加処理を開始します…`);
            let last = 0;
            const r = await withGuildLock(interaction.guildId, () => app.consent.rejoinMembers({
                rest: interaction.client.rest,
                queue: app.queue,
                sourceGuildId,
                targetGuildId: interaction.guildId,
                onProgress: (done, total) => {
                    if (Date.now() - last < 5000 && done !== total) return;
                    last = Date.now();
                    interaction.editReply(`⏳ 再参加中… ${done}/${total}`).catch(() => {});
                },
            }));
            app.logger.info('rejoin completed', { sourceGuildId, targetGuildId: interaction.guildId, ...r });
            return await interaction.editReply(formatRejoin(r, roleId)).catch(() => {});
        }
    } catch (err) {
        app.logger.error('members command failed', { sub, error: err });
        const msg = `❌ エラー: ${err.message}`;
        if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
        else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

function statusLabel(s) {
    return { active: '同意中', opted_out: '取り消し済み', revoked: '連携解除/失効' }[s] ?? s;
}

function formatRejoin(r, roleId) {
    const lines = [`✅ 完了（対象 ${r.total} 人）: 新規参加 ${r.added} / 参加済み ${r.alreadyMember}`];
    const detail = [];
    if (r.banned) detail.push(`BAN済み ${r.banned}`);
    if (r.accountDeleted) detail.push(`アカウント削除 ${r.accountDeleted}`);
    if (r.userLimited) detail.push(`アカウント制限 ${r.userLimited}`);
    if (r.guildLimit) detail.push(`参加上限 ${r.guildLimit}`);
    if (r.revoked) detail.push(`連携解除/失効 ${r.revoked}`);
    if (r.rateLimited) detail.push(`レート制限 ${r.rateLimited}`);
    if (r.failed) detail.push(`その他失敗 ${r.failed}`);
    if (detail.length) lines.push(`内訳: ${detail.join(' / ')}`);
    if (roleId) lines.push(`ロール付与: 成功 ${r.roleAssigned} / 失敗 ${r.roleFailed}`);
    if (r.aborted === 'invite_stopped') lines.push('⚠️ サーバー側で招待が停止されているため中断しました。設定を確認してください。');
    return lines.join('\n');
}

module.exports = { handleMembers };

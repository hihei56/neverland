'use strict';

const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { requireOwnerAdmin, withGuildLock } = require('./guard');
const { exportGuild } = require('../backup/exporter');
const { planForGuild, executeRestore } = require('../restore/executor');
const { isBackupId } = require('../models/backup');

const ENTITY_LABEL = { role: 'ロール', emoji: '絵文字', sticker: 'スタンプ', category: 'カテゴリ', channel: 'チャンネル', webhook: 'Webhook', guild: 'サーバー設定' };

async function handleBackup(interaction, app) {
    if (!(await requireOwnerAdmin(interaction, app.config))) return;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        switch (sub) {
            case 'export': return await doExport(interaction, app);
            case 'list': return await doList(interaction, app);
            case 'info': return await doInfo(interaction, app);
            case 'delete': return await doDelete(interaction, app);
            case 'restore': return await doRestore(interaction, app);
        }
    } catch (err) {
        app.logger.error('backup command failed', { sub, guildId: interaction.guildId, error: err });
        await safeEdit(interaction, `❌ エラー: ${err.message}`, app);
    }
}

async function doExport(interaction, app) {
    const manifest = await withGuildLock(interaction.guildId, () => exportGuild({
        guild: interaction.guild,
        repo: app.repo,
        queue: app.queue,
        logger: app.logger,
        maxAssetBytes: app.config.maxAssetBytes,
        userId: interaction.user.id,
        label: interaction.options.getString('label'),
    }));
    const lines = [
        `✅ バックアップを作成しました: \`${manifest.id}\``,
        `ロール ${manifest.roles.length} / カテゴリ ${manifest.categories.length} / チャンネル ${manifest.channels.length} / 絵文字 ${manifest.emojis.length} / スタンプ ${manifest.stickers.length} / Webhook ${manifest.webhooks.length}`,
        '※ メッセージ・メンバー一覧・Webhook URL は保存していません',
    ];
    if (manifest.warnings.length) lines.push('', `⚠️ 注意 ${manifest.warnings.length} 件`, ...manifest.warnings.slice(0, 8).map((w) => `- ${w}`));
    await interaction.editReply(truncate(lines.join('\n')));
}

async function doList(interaction, app) {
    const list = await app.repo.list(interaction.guildId);
    if (!list.length) return interaction.editReply('バックアップはまだありません。`/backup export` で作成できます。');
    const lines = list.slice(0, 20).map((b) =>
        `\`${b.id}\` ${b.label ? `「${b.label}」` : ''} — ロール${b.counts.roles} ch${b.counts.channels + b.counts.categories} 絵文字${b.counts.emojis}`);
    await interaction.editReply(truncate(`**バックアップ一覧**（新しい順, 最大20件）\n${lines.join('\n')}`));
}

async function loadAllowed(app, backupId) {
    if (!isBackupId(backupId)) throw new Error('backup_id の形式が不正です');
    const sourceGuildId = await app.repo.findGuildOf(backupId);
    if (!sourceGuildId || !app.config.allowedGuildIds.includes(sourceGuildId)) throw new Error('バックアップが見つかりません');
    return app.repo.load(sourceGuildId, backupId);
}

async function doInfo(interaction, app) {
    const m = await loadAllowed(app, interaction.options.getString('backup_id', true));
    const lines = [
        `**${m.id}** ${m.label ? `「${m.label}」` : ''}`,
        `元サーバー: ${m.source.guildName} (${m.source.guildId})`,
        `作成: <t:${Math.floor(new Date(m.createdAt).getTime() / 1000)}:F> by <@${m.createdBy}>`,
        `ロール ${m.roles.length} / カテゴリ ${m.categories.length} / チャンネル ${m.channels.length}`,
        `絵文字 ${m.emojis.length} / スタンプ ${m.stickers.length} / Webhook ${m.webhooks.length}`,
    ];
    if (m.warnings.length) lines.push(`⚠️ 取得時の注意 ${m.warnings.length} 件`);
    await interaction.editReply({ content: truncate(lines.join('\n')), allowedMentions: { parse: [] } });
}

async function doDelete(interaction, app) {
    const id = interaction.options.getString('backup_id', true);
    if (interaction.options.getString('confirm', true) !== id) {
        return interaction.editReply('確認用の入力が backup_id と一致しません。削除していません。');
    }
    const m = await loadAllowed(app, id);
    if (m.source.guildId !== interaction.guildId) return interaction.editReply('削除は元サーバー内でのみ実行できます。');
    await app.repo.remove(m.source.guildId, m.id);
    app.logger.info('backup deleted', { guildId: m.source.guildId, backupId: m.id, userId: interaction.user.id });
    await interaction.editReply(`🗑️ \`${m.id}\` を削除しました。`);
}

async function doRestore(interaction, app) {
    const manifest = await loadAllowed(app, interaction.options.getString('backup_id', true));
    const options = { guildSettings: interaction.options.getBoolean('guild_settings') ?? false };
    const execute = interaction.options.getBoolean('execute') ?? false;
    const confirm = (interaction.options.getString('confirm') || '').trim().toUpperCase();

    await withGuildLock(interaction.guildId, async () => {
        const plan = await planForGuild({ guild: interaction.guild, manifest, queue: app.queue, options });
        const planFile = new AttachmentBuilder(Buffer.from(JSON.stringify(plan, null, 2)), { name: `restore-plan-${plan.confirmCode}.json` });
        const creates = plan.actions.filter((a) => a.op === 'create' || a.op === 'update').length;

        if (!execute || confirm !== plan.confirmCode) {
            const header = execute
                ? `⛔ 確認コードが一致しないため実行していません。${confirm ? '（前回の dry-run 以降にサーバーが変化した可能性があります）' : ''}\n最新のプランは以下です。`
                : '🔍 **dry-run**（何も変更していません）';
            const footer = creates === 0
                ? '復元が必要な項目はありません。'
                : `実行するには:\n\`/backup restore backup_id:${manifest.id}${options.guildSettings ? ' guild_settings:True' : ''} execute:True confirm:${plan.confirmCode}\``;
            return interaction.editReply({ content: truncate([header, '', formatPlan(plan), '', footer].join('\n')), files: [planFile] });
        }

        await interaction.editReply(`⏳ 復元を開始します（${creates} 件）。既存のロール/チャンネルは変更しません。`);
        let last = 0;
        const { report } = await executeRestore({
            guild: interaction.guild,
            manifest,
            plan,
            repo: app.repo,
            queue: app.queue,
            logger: app.logger,
            dataDir: app.config.dataDir,
            userId: interaction.user.id,
            options,
            onProgress: (done, total) => {
                if (Date.now() - last < 5000 && done !== total) return;
                last = Date.now();
                safeEdit(interaction, `⏳ 復元中… ${done}/${total}`, app);
            },
        });
        const failures = report.results.filter((r) => r.status === 'failed');
        const lines = [
            `✅ 復元が完了しました: 成功 ${report.ok} / 失敗 ${report.failed} / スキップ ${report.skipped.length}`,
            ...failures.slice(0, 10).map((f) => `- ❌ ${ENTITY_LABEL[f.entity]} ${f.name}: ${f.error}`),
            report.results.some((r) => r.entity === 'webhook' && r.status === 'ok') ? '⚠️ Webhook は新しいURLで作成されました。連携先を再設定してください。' : '',
            '詳細ログは添付ファイルを参照してください。',
        ].filter(Boolean);
        const logFile = new AttachmentBuilder(Buffer.from(JSON.stringify(report, null, 2)), { name: 'restore-report.json' });
        await safeEdit(interaction, { content: truncate(lines.join('\n')), files: [logFile] }, app);
    });
}

function formatPlan(plan) {
    const lines = [];
    for (const [entity, c] of Object.entries(plan.summary)) {
        lines.push(`**${ENTITY_LABEL[entity]}**: 作成 ${c.create} / 既存を再利用 ${c.reuse} / スキップ ${c.skip}${c.update ? ` / 更新 ${c.update}` : ''}`);
        const creates = plan.actions.filter((a) => a.entity === entity && (a.op === 'create' || a.op === 'update'));
        if (creates.length) lines.push(`  ＋ ${creates.slice(0, 12).map((a) => a.name).join(', ')}${creates.length > 12 ? ` …他${creates.length - 12}` : ''}`);
        const skips = plan.actions.filter((a) => a.entity === entity && a.op === 'skip');
        for (const s of skips.slice(0, 3)) lines.push(`  － ${s.name}: ${s.reason}`);
    }
    if (plan.warnings.length) lines.push('', ...plan.warnings.map((w) => `⚠️ ${w}`));
    lines.push('', `確認コード: \`${plan.confirmCode}\``);
    return lines.join('\n');
}

/** インタラクショントークン(15分)切れでも落ちないように編集する。 */
async function safeEdit(interaction, payload, app) {
    try {
        await interaction.editReply(payload);
    } catch (err) {
        app.logger.warn('editReply failed', { error: err });
        if (typeof payload === 'object' && payload.content) {
            await interaction.user.send(payload).catch(() => {});
        }
    }
}

function truncate(s, max = 1900) {
    return s.length > max ? `${s.slice(0, max)}\n…（省略。詳細は添付ファイル）` : s;
}

module.exports = { handleBackup, formatPlan };

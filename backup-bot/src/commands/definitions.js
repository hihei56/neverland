'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } = require('discord.js');

// 管理コマンド: 許可ギルドにのみギルドコマンドとして登録。既定で管理者のみ表示。
const backup = new SlashCommandBuilder()
    .setName('backup')
    .setDescription('サーバー設定のバックアップ/復元')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('export').setDescription('現在のサーバー設定をバックアップします')
        .addStringOption((o) => o.setName('label').setDescription('メモ').setMaxLength(100)))
    .addSubcommand((s) => s.setName('list').setDescription('このサーバーのバックアップ一覧'))
    .addSubcommand((s) => s.setName('info').setDescription('バックアップの内容')
        .addStringOption((o) => o.setName('backup_id').setDescription('バックアップID').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('バックアップを削除')
        .addStringOption((o) => o.setName('backup_id').setDescription('バックアップID').setRequired(true))
        .addStringOption((o) => o.setName('confirm').setDescription('確認のため backup_id をもう一度入力').setRequired(true)))
    .addSubcommand((s) => s.setName('restore').setDescription('バックアップから不足分を復元（既定は dry-run）')
        .addStringOption((o) => o.setName('backup_id').setDescription('バックアップID').setRequired(true))
        .addBooleanOption((o) => o.setName('guild_settings').setDescription('サーバー名・認証レベル等も復元する（既定: false）'))
        .addBooleanOption((o) => o.setName('execute').setDescription('true で実際に実行（既定: false = dry-run）'))
        .addStringOption((o) => o.setName('confirm').setDescription('dry-run で表示された確認コード（execute 時に必須）')));

const members = new SlashCommandBuilder()
    .setName('members')
    .setDescription('同意済みメンバーの再参加機能')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('consent-link').setDescription('同意ページのリンクをこのチャンネルに案内します'))
    .addSubcommand((s) => s.setName('stats').setDescription('同意済み人数（このサーバー）'))
    .addSubcommand((s) => s.setName('rejoin').setDescription('同意済みメンバーをこのサーバーに再参加させる（既定は dry-run）')
        .addStringOption((o) => o.setName('source_guild').setDescription('同意を取得した元サーバーID（既定: このサーバー）'))
        .addBooleanOption((o) => o.setName('execute').setDescription('true で実行（既定: false = dry-run）'))
        .addStringOption((o) => o.setName('confirm').setDescription('dry-run で表示された確認コード')));

// 本人向けコマンド: サーバーを抜けた人も使えるよう、グローバル + DM でも利用可能。
const privacy = new SlashCommandBuilder()
    .setName('privacy')
    .setDescription('再参加機能のプライバシー設定')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addSubcommand((s) => s.setName('policy').setDescription('プライバシーポリシーを表示'))
    .addSubcommand((s) => s.setName('status').setDescription('自分の同意状況を確認'))
    .addSubcommand((s) => s.setName('optout').setDescription('再参加機能への同意を取り消す（トークンを失効・破棄）')
        .addStringOption((o) => o.setName('guild_id').setDescription('特定サーバーのみ取り消す場合のID（省略で全て）')))
    .addSubcommand((s) => s.setName('delete').setDescription('自分に関する同意記録をすべて削除')
        .addBooleanOption((o) => o.setName('confirm').setDescription('true で削除を実行').setRequired(true)));

module.exports = {
    guildCommands: [backup.toJSON(), members.toJSON()],
    globalCommands: [privacy.toJSON()],
};

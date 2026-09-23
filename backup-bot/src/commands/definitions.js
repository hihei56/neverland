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
    .addSubcommand((s) => s.setName('consent-link').setDescription('認証ボタンをこのチャンネルに投稿します')
        .addStringOption((o) => o.setName('for_guild').setDescription('どのサーバー向けの認証か（既定: このサーバー）。別サーバーから誘導する場合に指定'))
        .addStringOption((o) => o.setName('title').setDescription('Embedのタイトル（既定: サーバー名 VERIFY）').setMaxLength(256))
        .addStringOption((o) => o.setName('description').setDescription('Embedの本文（既定: 荒らし対策用の認証です…）').setMaxLength(2000))
        .addBooleanOption((o) => o.setName('webhook').setDescription('Webhook経由で投稿し、送信者名をタイトルにする（既定: false）'))
        .addStringOption((o) => o.setName('sender_name').setDescription('Webhook投稿時の送信者名（既定: タイトル）').setMaxLength(80)))
    .addSubcommand((s) => s.setName('authlog').setDescription('認証ログの投稿先チャンネルを設定/解除/確認')
        .addChannelOption((o) => o.setName('channel').setDescription('ログ投稿先（省略で現在の設定を表示）'))
        .addBooleanOption((o) => o.setName('off').setDescription('true で認証ログを無効化')))
    .addSubcommand((s) => s.setName('stats').setDescription('同意済み人数（このサーバー）'))
    .addSubcommand((s) => s.setName('info').setDescription('指定した認証済みメンバーの保存情報を表示（管理者用）')
        .addStringOption((o) => o.setName('user_id').setDescription('対象ユーザーID').setRequired(true)))
    .addSubcommand((s) => s.setName('rejoin').setDescription('同意済みメンバーをこのサーバーに再参加させる（既定は dry-run）')
        .addStringOption((o) => o.setName('source_guild').setDescription('同意を取得した元サーバーID（既定: このサーバー）'))
        .addBooleanOption((o) => o.setName('execute').setDescription('true で実行（既定: false = dry-run）'))
        .addStringOption((o) => o.setName('confirm').setDescription('dry-run で表示された確認コード')))
    // 本人からの依頼を受けて管理者が実行する削除（コマンドは管理者限定）
    .addSubcommand((s) => s.setName('forget').setDescription('指定ユーザーの同意・トークン・取得情報をすべて削除（本人の依頼を受けて）')
        .addStringOption((o) => o.setName('user_id').setDescription('対象ユーザーID').setRequired(true))
        .addStringOption((o) => o.setName('confirm').setDescription('確認のため user_id をもう一度入力').setRequired(true)));

// 簡略化モデレーション（NGワード自動削除）。適用ロールを設定、初期は全員。
const moderation = new SlashCommandBuilder()
    .setName('moderation')
    .setDescription('NGワード自動削除の設定（管理者用）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('show').setDescription('現在の設定を表示'))
    .addSubcommand((s) => s.setName('toggle').setDescription('NGワード削除の有効/無効を切り替え')
        .addBooleanOption((o) => o.setName('enabled').setDescription('true で有効').setRequired(true)))
    .addSubcommand((s) => s.setName('spam').setDescription('連投スパムの累進処罰（削除→タイムアウト→キック）の有効/無効')
        .addBooleanOption((o) => o.setName('enabled').setDescription('true で有効').setRequired(true)))
    .addSubcommand((s) => s.setName('target-add').setDescription('適用対象ロールを追加（追加するとそのロール保持者のみ対象）')
        .addRoleOption((o) => o.setName('role').setDescription('対象ロール').setRequired(true)))
    .addSubcommand((s) => s.setName('target-clear').setDescription('適用対象ロールを全解除（＝全員に適用）'))
    .addSubcommand((s) => s.setName('ngword').setDescription('NGワードの追加/削除/一覧')
        .addStringOption((o) => o.setName('action').setDescription('操作').setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
        .addStringOption((o) => o.setName('word').setDescription('対象の語（add/remove時）').setMaxLength(100)));

module.exports = {
    guildCommands: [backup.toJSON(), members.toJSON(), moderation.toJSON()],
    // 本人向けのグローバルコマンドは廃止（コマンドは管理者限定）。
    // 利用者は Discord「認証済みアプリ」から連携解除でき、削除は運営者へ依頼する（プライバシーポリシー参照）。
    globalCommands: [],
};

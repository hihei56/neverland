'use strict';

const { PermissionFlagsBits, MessageFlags } = require('discord.js');

/**
 * 管理コマンドの実行条件:
 *   1. 実行者が BOT_OWNER_IDS に含まれる
 *   2. ギルドが ALLOWED_GUILD_IDS に含まれる
 *   3. 実行者がそのギルドで Administrator を持つ
 * @returns {Promise<boolean>} 拒否した場合は返信済みで false
 */
async function requireOwnerAdmin(interaction, config) {
    let reason = null;
    if (!interaction.inGuild()) reason = 'サーバー内で実行してください';
    else if (!config.ownerIds.includes(interaction.user.id)) reason = 'このコマンドはBotの所有者のみ実行できます';
    else if (!config.allowedGuildIds.includes(interaction.guildId)) reason = 'このサーバーは ALLOWED_GUILD_IDS に含まれていません';
    else if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) reason = '管理者権限が必要です';
    if (reason) {
        await interaction.reply({ content: `⛔ ${reason}`, flags: MessageFlags.Ephemeral });
        return false;
    }
    return true;
}

/** ギルド単位の排他（同時に export/restore を走らせない）。 */
const running = new Set();
async function withGuildLock(guildId, fn) {
    if (running.has(guildId)) throw new Error('このサーバーでは別の処理が実行中です。完了を待ってください');
    running.add(guildId);
    try {
        return await fn();
    } finally {
        running.delete(guildId);
    }
}

module.exports = { requireOwnerAdmin, withGuildLock };

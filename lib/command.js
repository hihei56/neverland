// lib/command.js — 「!コマンド」の解析と、各機能で共通の小道具
const { PermissionFlagsBits } = require('discord.js');

/** "!count off #ch" → { name: '!count', args: ['off', '<#123>'] } */
function parseCommand(content) {
    const parts = content.trim().split(/\s+/);
    return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

function isAdmin(member) {
    return !!member?.permissions.has(PermissionFlagsBits.Administrator);
}

/**
 * コマンド引数からチャンネルを解決する。
 * チャンネルメンション（#xxx）優先、なければ引数のどれかがチャンネルIDならそれ。
 * どちらも無ければ null（呼び出し側で message.channel にフォールバック）。
 */
function resolveTargetChannel(message, args) {
    const mentioned = message.mentions.channels.first();
    if (mentioned) return mentioned;
    for (const token of args) {
        if (/^\d{17,20}$/.test(token)) {
            const ch = message.guild?.channels.cache.get(token);
            if (ch) return ch;
        }
    }
    return null;
}

/** 返信文用：「このチャンネル」または <#id> */
function channelLabel(target, message) {
    return target.id === message.channel.id ? 'このチャンネル' : `<#${target.id}>`;
}

module.exports = { parseCommand, isAdmin, resolveTargetChannel, channelLabel };

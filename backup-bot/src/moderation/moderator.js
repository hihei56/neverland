'use strict';

// 簡略化モデレーション: NGワードを含むメッセージを自動削除する。
// （元の moderator.js からスパム/呪い/擬似リプライ等は除き、NGワード削除のみ）
//
// 適用対象: settings.targetRoleIds が空なら全員。ロール指定があればその保持者のみ。
// 除外: 管理者・メッセージ管理権限を持つメンバーは対象外。

const { PermissionFlagsBits } = require('discord.js');

/** 検知用に正規化（全角→半角、小文字化、空白/記号ゆらぎの簡易吸収）。 */
function normalize(text) {
    if (!text) return '';
    return String(text)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, '');
}

/** NGワードに1つでも一致するか。ワード側も正規化して部分一致で判定。 */
function matchNgWord(content, ngWords) {
    const text = normalize(content);
    if (!text) return null;
    for (const w of ngWords) {
        const nw = normalize(w);
        if (nw && text.includes(nw)) return w;
    }
    return null;
}

/** 対象ロールに該当するか（空なら全員対象）。 */
function isTargeted(member, targetRoleIds) {
    if (!targetRoleIds || targetRoleIds.length === 0) return true;
    return targetRoleIds.some((id) => member?.roles?.cache?.has(id));
}

/** メッセージ管理者/管理者は除外。 */
function isExempt(member) {
    const p = member?.permissions;
    return Boolean(p?.has?.(PermissionFlagsBits.Administrator) || p?.has?.(PermissionFlagsBits.ManageMessages));
}

/**
 * 削除すべきかの純粋判定（テスト用）。
 * @returns {{ action: 'none'|'delete', reason?: string, matched?: string }}
 */
function decide({ content, member }, settings) {
    if (!settings?.enabled) return { action: 'none' };
    if (isExempt(member)) return { action: 'none' };
    if (!isTargeted(member, settings.targetRoleIds)) return { action: 'none' };
    const matched = matchNgWord(content, settings.ngWords || []);
    if (matched) return { action: 'delete', reason: 'ngword', matched };
    return { action: 'none' };
}

/**
 * 実メッセージを処理する。
 *  - NGワード一致 → 削除
 *  - 連投スパム（spamEnabled かつ flood/strikes 提供時） → 削除＋累進処罰（タイムアウト/キック）
 * @param {import('discord.js').Message} message
 * @param {{ store: import('./moderationStore').ModerationStore, allowedGuildIds: string[], logger: any,
 *           flood?: { isFlooding(id:string):boolean }, strikes?: any, enforce?: Function }} deps
 */
async function handleMessage(message, { store, allowedGuildIds, logger, flood, strikes, enforce }) {
    if (message.author?.bot || !message.guild) return;
    if (!allowedGuildIds.includes(message.guild.id)) return; // 許可ギルドのみ
    if (!message.content && !message.attachments?.size) return;

    const settings = await store.get(message.guild.id);
    // 対象判定（除外されておらず、対象ロールに該当）。enabled は NG ワード側で判定。
    const targetedNonExempt = !isExempt(message.member) && isTargeted(message.member, settings.targetRoleIds);

    // 連投スパム（累進処罰）を先に判定
    if (targetedNonExempt && settings.spamEnabled && flood && strikes && enforce) {
        if (flood.isFlooding(message.author.id)) {
            await message.delete().catch(() => {});
            await enforce(message, { strikeStore: strikes, logger });
            return;
        }
    }

    // NGワード削除
    const verdict = decide({ content: message.content || '', member: message.member }, settings);
    if (verdict.action !== 'delete') return;
    try {
        await message.delete();
        logger.info('moderation deleted', {
            guildId: message.guild.id, userId: message.author.id, reason: verdict.reason, matched: verdict.matched,
        });
    } catch (err) {
        logger.warn('moderation delete failed', { guildId: message.guild.id, error: err });
    }
}

module.exports = { normalize, matchNgWord, isTargeted, isExempt, decide, handleMessage };

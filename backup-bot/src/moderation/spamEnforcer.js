'use strict';

// 連投スパムへの累進処罰（簡略版 spam_enforcer.js）。
//   連投を検知 → メッセージ削除 → 違反回数に応じて タイムアウトを段階的に延長 → 最終的にキック。
//   違反回数は 14 日間記憶する。元の対話的な解除ボタン/専用ログチャンネルは省略。

const path = require('node:path');
const { readJson, updateJson } = require('../storage/jsonFile');

// 段階処罰（分単位のタイムアウト、最後は 'kick'）。1回目から即タイムアウト。
const ESCALATION = [10, 60, 360, 1440, 40320, 'kick'];
const STRIKE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** 違反回数(1始まり) → 処罰（分 or 'kick'）。 */
function escalationAction(count) {
    return ESCALATION[Math.min(Math.max(count, 1) - 1, ESCALATION.length - 1)];
}

/** 連投検知。windowMs 内に threshold 通で「連投」とみなす。 */
function createFloodTracker({ windowMs = 4000, threshold = 2 } = {}) {
    const map = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [id, times] of map) if (times.every((t) => now - t >= windowMs)) map.delete(id);
    }, 60_000);
    timer.unref?.();
    return {
        isFlooding(userId) {
            const now = Date.now();
            const times = (map.get(userId) || []).filter((t) => now - t < windowMs);
            times.push(now);
            map.set(userId, times);
            return times.length >= threshold;
        },
    };
}

/** 違反回数を data/spam_strikes.json に永続化。 */
class StrikeStore {
    constructor(dataDir, windowMs = STRIKE_WINDOW_MS) {
        this.file = path.join(dataDir, 'spam_strikes.json');
        this.windowMs = windowMs;
        this.empty = {};
    }

    async bump(userId) {
        let count = 1;
        await updateJson(this.file, this.empty, (db) => {
            const rec = db[userId];
            const now = Date.now();
            if (!rec || now - rec.lastAt > this.windowMs) db[userId] = { count: 1, lastAt: now };
            else { rec.count += 1; rec.lastAt = now; }
            count = db[userId].count;
            return db;
        });
        return count;
    }

    async get(userId) {
        const db = await readJson(this.file, this.empty);
        const rec = db[userId];
        return rec && Date.now() - rec.lastAt <= this.windowMs ? rec.count : 0;
    }

    async reset(userId) {
        await updateJson(this.file, this.empty, (db) => { delete db[userId]; return db; });
    }
}

/**
 * 累進処罰を適用する（呼び出し側でメッセージ削除済みの想定）。
 * @returns {Promise<{ count: number, action: number|'kick'|null }>}
 */
async function enforce(message, { strikeStore, logger }) {
    const count = await strikeStore.bump(message.author.id);
    const action = escalationAction(count);
    const member = message.member;
    const reason = `スパム連投（${count}回目）`;
    try {
        if (action === 'kick') {
            if (member?.kickable) await member.kick(reason);
        } else if (typeof action === 'number' && member?.moderatable) {
            await member.timeout(action * 60 * 1000, reason);
        }
    } catch (err) {
        logger.warn('spam enforce action failed', { userId: message.author.id, action, error: err });
    }
    logger.info('spam enforced', { guildId: message.guild?.id, userId: message.author.id, count, action });
    return { count, action };
}

module.exports = { ESCALATION, escalationAction, createFloodTracker, StrikeStore, enforce };

'use strict';

const path = require('node:path');
const { readJson, updateJson } = require('../storage/jsonFile');

/**
 * 同意記録ストア。トークンは暗号化してから渡すこと（このクラスは平文トークンを扱わない）。
 */
class ConsentStore {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'consents.json');
        this.empty = { records: [], events: [] };
    }

    async all() {
        return readJson(this.file, this.empty);
    }

    async get(userId, guildId) {
        const { records } = await this.all();
        return records.find((r) => r.userId === userId && r.guildId === guildId) ?? null;
    }

    async listByUser(userId) {
        return (await this.all()).records.filter((r) => r.userId === userId);
    }

    async listActive(guildId) {
        return (await this.all()).records.filter((r) => r.guildId === guildId && r.status === 'active' && r.tokens);
    }

    /** @param {import('../models/consent').ConsentRecord} record */
    async upsert(record, eventAction) {
        await updateJson(this.file, this.empty, (db) => {
            db.records = db.records.filter((r) => !(r.userId === record.userId && r.guildId === record.guildId));
            db.records.push(record);
            if (eventAction) db.events.push(event(record, eventAction));
            return db;
        });
    }

    async setTokens(userId, guildId, tokens) {
        await updateJson(this.file, this.empty, (db) => {
            const r = db.records.find((x) => x.userId === userId && x.guildId === guildId);
            if (r) {
                r.tokens = tokens;
                r.updatedAt = new Date().toISOString();
            }
            return db;
        });
    }

    /** トークンを破棄し status を変更する（オプトアウト・失効時）。 */
    async deactivate(userId, guildId, status, eventAction) {
        let changed = null;
        await updateJson(this.file, this.empty, (db) => {
            for (const r of db.records) {
                if (r.userId !== userId || (guildId && r.guildId !== guildId)) continue;
                r.status = status;
                r.tokens = null;
                r.updatedAt = new Date().toISOString();
                db.events.push(event(r, eventAction));
                changed = (changed ?? 0) + 1;
            }
            return db;
        });
        return changed ?? 0;
    }

    async recordEvent(record, action) {
        await updateJson(this.file, this.empty, (db) => {
            db.events.push(event(record, action));
            return db;
        });
    }

    /** 本人の削除依頼: 同意記録と履歴をすべて削除する。 */
    async deleteUser(userId) {
        let removed = 0;
        await updateJson(this.file, this.empty, (db) => {
            const before = db.records.length + db.events.length;
            db.records = db.records.filter((r) => r.userId !== userId);
            db.events = db.events.filter((e) => e.userId !== userId);
            removed = before - db.records.length - db.events.length;
            return db;
        });
        return removed;
    }
}

function event(record, action) {
    return { at: new Date().toISOString(), userId: record.userId, guildId: record.guildId, action, policyVersion: record.policyVersion };
}

module.exports = { ConsentStore };

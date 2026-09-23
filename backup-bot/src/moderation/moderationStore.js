'use strict';

// ギルドごとのモデレーション設定。 data/moderation.json
// { guilds: { "<guildId>": { enabled, targetRoleIds:[], ngWords:[] } } }
//
// targetRoleIds が空 = 全員（@everyone）に適用。ロールを入れると、そのロール保持者だけに適用。

const path = require('node:path');
const { readJson, updateJson } = require('../storage/jsonFile');

const DEFAULT = { enabled: true, targetRoleIds: [], ngWords: [], spamEnabled: false };

class ModerationStore {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'moderation.json');
        this.empty = { guilds: {} };
    }

    async get(guildId) {
        const db = await readJson(this.file, this.empty);
        return { ...DEFAULT, ...(db.guilds[guildId] || {}) };
    }

    /** @param {(s: typeof DEFAULT) => void} mutate */
    async update(guildId, mutate) {
        let result;
        await updateJson(this.file, this.empty, (db) => {
            const s = { ...DEFAULT, ...(db.guilds[guildId] || {}) };
            mutate(s);
            db.guilds[guildId] = s;
            result = s;
            return db;
        });
        return result;
    }
}

module.exports = { ModerationStore, DEFAULT };

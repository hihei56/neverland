'use strict';

// ギルドごとの認証ログ投稿先チャンネル。 data/auth_log.json
// { guilds: { "<guildId>": "<channelId>" | null } }
//
// コマンド（/members authlog）で設定・解除できる。未設定のギルドは
// .env の AUTH_LOG_CHANNEL_IDS を既定値として使う（コマンドの設定が優先）。
// 明示的に解除した場合は null を保存し、既定値も無効化する。

const path = require('node:path');
const { readJson, updateJson } = require('../storage/jsonFile');

class AuthLogStore {
    /**
     * @param {string} dataDir
     * @param {Map<string,string>} [defaults] .env 由来の既定値（guildId -> channelId）
     */
    constructor(dataDir, defaults = new Map()) {
        this.file = path.join(dataDir, 'auth_log.json');
        this.empty = { guilds: {} };
        this.defaults = defaults;
    }

    /** @returns {Promise<string|null>} 投稿先チャンネルID（無ければ null） */
    async get(guildId) {
        const db = await readJson(this.file, this.empty);
        if (Object.prototype.hasOwnProperty.call(db.guilds, guildId)) {
            return db.guilds[guildId] || null; // 明示的な設定（null=解除）を優先
        }
        return this.defaults.get(guildId) || null;
    }

    async set(guildId, channelId) {
        await updateJson(this.file, this.empty, (db) => {
            db.guilds[guildId] = channelId;
            return db;
        });
    }

    async clear(guildId) {
        await updateJson(this.file, this.empty, (db) => {
            db.guilds[guildId] = null; // 既定値も無効化する
            return db;
        });
    }
}

module.exports = { AuthLogStore };

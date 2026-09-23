'use strict';

// 同意したユーザーのデータ。data/users.json に保存する。
//
// データモデル:
// {
//   "users": {
//     "<userId>": LinkRecord
//   }
// }
//
// @typedef {Object} LinkRecord
// @property {string} userId
// @property {'active'|'opted_out'} status
// @property {{ consentedAt: string, policyVersion: string, scopes: string[] }} consent
// @property {Sealed|null} profile   暗号化した { username, globalName, email, emailVerified, connections, fetchedAt }
// @property {Sealed|null} tokens    暗号化した { accessToken, refreshToken, expiresAt, scope }
// @property {string} updatedAt
// @property {string} [optedOutAt]
//
// opted_out のレコードには userId と日時だけが残る（profile/tokens は null）。
// 削除依頼ではレコードそのものを消す。

const path = require('node:path');
const { readJson, updateJson } = require('./jsonFile');

class UserStore {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'users.json');
        this.empty = { users: {} };
    }

    async get(userId) {
        const db = await readJson(this.file, this.empty);
        return db.users[userId] ?? null;
    }

    async list() {
        const db = await readJson(this.file, this.empty);
        return Object.values(db.users);
    }

    async put(record) {
        await updateJson(this.file, this.empty, (db) => {
            db.users[record.userId] = record;
            return db;
        });
    }

    /** レコードを部分更新する。存在しなければ何もしないで null を返す。 */
    async patch(userId, fn) {
        let result = null;
        await updateJson(this.file, this.empty, (db) => {
            const r = db.users[userId];
            if (r) {
                result = fn(r) ?? r;
                result.updatedAt = new Date().toISOString();
                db.users[userId] = result;
            }
            return db;
        });
        return result;
    }

    async remove(userId) {
        let existed = false;
        await updateJson(this.file, this.empty, (db) => {
            existed = userId in db.users;
            delete db.users[userId];
            return db;
        });
        return existed;
    }
}

module.exports = { UserStore };

'use strict';

const crypto = require('node:crypto');
const { Routes } = require('discord.js');
const { REQUIRED_SCOPES } = require('../models/consent');
const { OAuthError } = require('./discordOAuth');

/**
 * 同意の取得・オプトアウト・削除・同意済みメンバーの再参加をまとめる。
 */
class ConsentService {
    /**
     * @param {Object} deps
     * @param {import('./consentStore').ConsentStore} deps.store
     * @param {ReturnType<import('./crypto').createCipher>} deps.cipher
     * @param {ReturnType<import('./discordOAuth').createDiscordOAuth>} deps.oauth
     * @param {string} deps.policyVersion
     * @param {string[]} deps.allowedGuildIds
     * @param {any} deps.logger
     */
    constructor({ store, cipher, oauth, policyVersion, allowedGuildIds, logger }) {
        Object.assign(this, { store, cipher, oauth, policyVersion, logger });
        this.allowed = new Set(allowedGuildIds);
        /** state -> { guildId, expires } （CSRF対策、10分で失効） */
        this.states = new Map();
    }

    startAuthorization(guildId) {
        if (!this.allowed.has(guildId)) throw new Error('対象外のサーバーです');
        this.#gcStates();
        const state = crypto.randomBytes(24).toString('base64url');
        this.states.set(state, { guildId, expires: Date.now() + 10 * 60_000 });
        return this.oauth.authorizeUrl(state, REQUIRED_SCOPES);
    }

    /** OAuthコールバック処理。成功時は同意記録を保存する。 */
    async completeAuthorization(code, state) {
        const s = this.states.get(state);
        this.states.delete(state);
        if (!s || s.expires < Date.now()) throw new Error('リンクの有効期限が切れています。最初からやり直してください');

        const token = await this.oauth.exchangeCode(code);
        const granted = String(token.scope || '').split(' ');
        const missing = REQUIRED_SCOPES.filter((sc) => !granted.includes(sc));
        if (missing.length) {
            await this.#revokeQuietly(token.access_token, 'access_token');
            throw new Error(`必要な権限が許可されませんでした: ${missing.join(', ')}`);
        }
        const user = await this.oauth.me(token.access_token);
        const now = new Date().toISOString();
        await this.store.upsert({
            userId: user.id,
            guildId: s.guildId,
            scopes: granted,
            policyVersion: this.policyVersion,
            consentedAt: now,
            updatedAt: now,
            status: 'active',
            tokens: this.#encryptTokens(token),
        }, 'granted');
        this.logger.info('consent granted', { guildId: s.guildId });
        return { userId: user.id, guildId: s.guildId };
    }

    /** オプトアウト: トークンを Discord 側で失効させ、保存分も破棄する。記録は status=opted_out で残る。 */
    async optOut(userId, guildId = null) {
        const records = (await this.store.listByUser(userId)).filter((r) => !guildId || r.guildId === guildId);
        for (const r of records) await this.#revokeRecordTokens(r);
        return this.store.deactivate(userId, guildId, 'opted_out', 'opted_out');
    }

    /** 削除依頼: トークンを失効させ、同意記録と履歴を完全に削除する。 */
    async deleteAll(userId) {
        for (const r of await this.store.listByUser(userId)) await this.#revokeRecordTokens(r);
        const removed = await this.store.deleteUser(userId);
        this.logger.info('consent data deleted on request', { removedEntries: removed });
        return removed;
    }

    async status(userId) {
        return (await this.store.listByUser(userId)).map((r) => ({
            guildId: r.guildId, status: r.status, consentedAt: r.consentedAt, policyVersion: r.policyVersion,
        }));
    }

    async countActive(guildId) {
        return (await this.store.listActive(guildId)).length;
    }

    /**
     * 同意済みユーザーを targetGuild に参加させる（guilds.join）。
     * sourceGuildId で同意したユーザーのみが対象。ロール付与は行わない。
     * @returns {Promise<{ added: number, alreadyMember: number, revoked: number, failed: number }>}
     */
    async rejoinMembers({ rest, queue, sourceGuildId, targetGuildId, onProgress }) {
        const records = await this.store.listActive(sourceGuildId);
        const result = { added: 0, alreadyMember: 0, revoked: 0, failed: 0 };
        let i = 0;
        for (const r of records) {
            try {
                const accessToken = await this.#validAccessToken(r);
                if (!accessToken) {
                    result.revoked++;
                } else {
                    const res = await queue.add('guilds.join', () =>
                        rest.put(Routes.guildMember(targetGuildId, r.userId), { body: { access_token: accessToken } }),
                    );
                    // 201 はメンバーJSON(新規参加)、204 は既に参加済み（本文なし→空のArrayBuffer）
                    if (res && typeof res === 'object' && 'user' in res) {
                        result.added++;
                        await this.store.recordEvent(r, 'rejoined');
                    } else {
                        result.alreadyMember++;
                    }
                }
            } catch (err) {
                result.failed++;
                this.logger.error('rejoin failed', { targetGuildId, error: err });
            }
            onProgress?.(++i, records.length);
        }
        return result;
    }

    async #validAccessToken(record) {
        const t = record.tokens;
        if (!t) return null;
        // 期限の1時間前からはリフレッシュする
        if (new Date(t.expiresAt).getTime() - Date.now() > 60 * 60_000) return this.cipher.decrypt(t.accessToken);
        try {
            const fresh = await this.oauth.refresh(this.cipher.decrypt(t.refreshToken));
            await this.store.setTokens(record.userId, record.guildId, this.#encryptTokens(fresh));
            return fresh.access_token;
        } catch (err) {
            if (err instanceof OAuthError && err.oauthError === 'invalid_grant') {
                // 本人が「認証済みアプリ」から連携解除した等。以後は使わない。
                await this.store.deactivate(record.userId, record.guildId, 'revoked', 'token_revoked');
                return null;
            }
            throw err;
        }
    }

    #encryptTokens(token) {
        return {
            accessToken: this.cipher.encrypt(token.access_token),
            refreshToken: this.cipher.encrypt(token.refresh_token),
            expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000).toISOString(),
        };
    }

    async #revokeRecordTokens(record) {
        if (!record.tokens) return;
        try {
            await this.#revokeQuietly(this.cipher.decrypt(record.tokens.refreshToken), 'refresh_token');
        } catch (err) {
            this.logger.warn('token decrypt failed during revoke', { error: err });
        }
    }

    async #revokeQuietly(token, hint) {
        try {
            await this.oauth.revoke(token, hint);
        } catch (err) {
            this.logger.warn('token revoke failed', { error: err });
        }
    }

    #gcStates() {
        const now = Date.now();
        for (const [k, v] of this.states) if (v.expires < now) this.states.delete(k);
    }
}

module.exports = { ConsentService };

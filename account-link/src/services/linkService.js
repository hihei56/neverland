'use strict';

// 同意ベースのアカウント連携の中核ロジック。
//
// 原則:
//   - 本人が同意画面でチェックを入れ、さらに Discord の認可画面で許可した場合だけ取得する
//   - 取得に失敗した・スコープが足りない場合は、トークンを失効させて何も保存しない
//   - 本人確認（/me の閲覧・撤回）には identify だけの別フローを使い、そのトークンは保存しない

const { randomToken } = require('../crypto');
const { DiscordApiError } = require('../discord/client');

const LINK_SCOPES = ['identify', 'email', 'connections'];
const MANAGE_SCOPES = ['identify'];
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 10_000;

class LinkService {
    /**
     * @param {Object} deps
     * @param {ReturnType<import('../discord/client').createDiscordClient>} deps.discord
     * @param {import('../store/userStore').UserStore} deps.users
     * @param {import('../store/consentLog').ConsentLog} deps.log
     * @param {ReturnType<import('../crypto').createCrypto>} deps.crypto
     * @param {string} deps.policyVersion
     * @param {number} deps.retentionDays
     * @param {any} deps.logger
     */
    constructor({ discord, users, log, crypto, policyVersion, retentionDays, logger }) {
        Object.assign(this, { discord, users, log, crypto, policyVersion, retentionDays, logger });
        /** state -> { flow, expires }（1回限り） */
        this.pendingStates = new Map();
    }

    // ---- OAuth 開始 -----------------------------------------------------

    /**
     * @param {'link'|'manage'} flow
     * @returns {{ state: string, url: string }}
     */
    begin(flow) {
        this.#gcStates();
        if (this.pendingStates.size >= MAX_PENDING_STATES) throw new Error('混雑しています。しばらくしてから再度お試しください');
        const state = randomToken(24);
        this.pendingStates.set(state, { flow, expires: Date.now() + STATE_TTL_MS });
        const scopes = flow === 'link' ? LINK_SCOPES : MANAGE_SCOPES;
        return { state, url: this.discord.authorizeUrl({ state, scopes }) };
    }

    /** state を検証して消費する（再利用不可）。 */
    consumeState(state) {
        const s = this.pendingStates.get(state);
        this.pendingStates.delete(state);
        if (!s || s.expires < Date.now()) return null;
        return s.flow;
    }

    // ---- 連携（同意して取得） ------------------------------------------

    /** 認可コードからデータを取得して保存する。 */
    async completeLink(code) {
        const token = await this.discord.exchangeCode(code);
        try {
            const granted = String(token.scope || '').split(' ').filter(Boolean);
            const missing = LINK_SCOPES.filter((s) => !granted.includes(s));
            if (missing.length) throw new UserFacingError(`必要な許可が得られませんでした（${missing.join(', ')}）。何も保存していません。`);

            const profile = await this.#fetchProfile(token.access_token);
            // 再同意の場合、古いトークンは失効させてから置き換える
            const previous = await this.users.get(profile.userId);
            if (previous) await this.#revokeRecord(previous);
            const now = new Date().toISOString();
            await this.users.put({
                userId: profile.userId,
                status: 'active',
                consent: { consentedAt: now, policyVersion: this.policyVersion, scopes: granted },
                profile: this.crypto.seal(profile.data),
                tokens: this.crypto.seal(tokenBundle(token)),
                updatedAt: now,
            });
            await this.log.append(profile.userId, 'consent_granted', { policyVersion: this.policyVersion, scopes: granted });
            this.logger.info('link completed', { subject: this.crypto.pseudonym(profile.userId) });
            return { userId: profile.userId };
        } catch (err) {
            // 保存しないと決めたトークンは Discord 側でも無効にしておく
            await this.#revokeQuietly(token.access_token, 'access_token');
            throw err;
        }
    }

    // ---- 本人確認（identify のみ、トークンは保存しない） ----------------

    async completeManage(code) {
        const token = await this.discord.exchangeCode(code);
        try {
            const me = await this.discord.me(token.access_token);
            return { userId: me.id };
        } finally {
            await this.#revokeQuietly(token.access_token, 'access_token');
        }
    }

    // ---- 本人向け: 閲覧・撤回 ------------------------------------------

    /** 本人に見せる保存データ（復号済み）。 */
    async view(userId) {
        const r = await this.users.get(userId);
        if (!r) return null;
        return {
            userId: r.userId,
            status: r.status,
            consent: r.consent,
            optedOutAt: r.optedOutAt ?? null,
            profile: r.profile ? this.crypto.open(r.profile) : null,
            hasToken: Boolean(r.tokens),
        };
    }

    /** 同意の撤回: トークンを失効・破棄し、email/connections を消去。userId と撤回日時だけ残す。 */
    async optOut(userId, { actor = 'user', event = 'opted_out' } = {}) {
        const r = await this.users.get(userId);
        if (!r || r.status === 'opted_out') return false;
        await this.#revokeRecord(r);
        await this.users.patch(userId, (x) => ({
            userId: x.userId,
            status: 'opted_out',
            consent: x.consent,
            profile: null,
            tokens: null,
            optedOutAt: new Date().toISOString(),
        }));
        await this.log.append(userId, event, { policyVersion: this.policyVersion, actor });
        return true;
    }

    /**
     * 削除（管理者専用・運営者 CLI からのみ呼ぶ）: レコードを完全に削除する。
     * purgeLog=true なら仮名化された同意ログも消す。
     */
    async delete(userId, { actor = 'operator', purgeLog = false } = {}) {
        const r = await this.users.get(userId);
        if (r) await this.#revokeRecord(r);
        const existed = await this.users.remove(userId);
        if (purgeLog) await this.log.purge(userId);
        else if (existed) await this.log.append(userId, 'deleted', { actor });
        return existed;
    }

    // ---- 運営者向け -----------------------------------------------------

    /** 保存済みトークンでデータを再取得する。連携解除されていれば撤回として扱う。 */
    async refresh(userId) {
        const r = await this.users.get(userId);
        if (!r || r.status !== 'active' || !r.tokens) return { ok: false, reason: '有効な同意がありません' };
        let tokens = this.crypto.open(r.tokens);
        try {
            if (Date.parse(tokens.expiresAt) - Date.now() < 5 * 60_000) {
                tokens = tokenBundle(await this.discord.refresh(tokens.refreshToken));
            }
            const profile = await this.#fetchProfile(tokens.accessToken);
            if (profile.userId !== userId) throw new Error('トークンの所有者が一致しません');
            await this.users.patch(userId, (x) => {
                x.profile = this.crypto.seal(profile.data);
                x.tokens = this.crypto.seal(tokens);
            });
            await this.log.append(userId, 'data_refreshed', { actor: 'operator' });
            return { ok: true };
        } catch (err) {
            if (err instanceof DiscordApiError && (err.status === 401 || err.oauthError === 'invalid_grant')) {
                await this.optOut(userId, { actor: 'system', event: 'token_invalid' });
                return { ok: false, reason: 'Discord 側で連携が解除されていたため、撤回として処理しました' };
            }
            throw err;
        }
    }

    /** 保存期間を過ぎたデータを削除する。 */
    async purgeExpired(now = Date.now()) {
        const limit = this.retentionDays * 86_400_000;
        let count = 0;
        for (const r of await this.users.list()) {
            const since = Date.parse(r.status === 'opted_out' ? r.optedOutAt : r.consent.consentedAt);
            if (now - since < limit) continue;
            if (r.tokens) await this.#revokeRecord(r);
            await this.users.remove(r.userId);
            await this.log.append(r.userId, 'expired', { actor: 'system' });
            count++;
        }
        return count;
    }

    // ---- 内部 -----------------------------------------------------------

    async #fetchProfile(accessToken) {
        const me = await this.discord.me(accessToken);
        const connections = await this.discord.myConnections(accessToken);
        return {
            userId: me.id,
            data: {
                username: me.username,
                globalName: me.global_name ?? null,
                email: me.email ?? null,
                emailVerified: Boolean(me.verified),
                // 必要最小限の項目だけ保持する
                connections: (connections || []).map((c) => ({
                    type: c.type,
                    id: c.id,
                    name: c.name,
                    verified: Boolean(c.verified),
                    visibility: c.visibility,
                })),
                fetchedAt: new Date().toISOString(),
            },
        };
    }

    async #revokeRecord(record) {
        if (!record.tokens) return;
        try {
            const t = this.crypto.open(record.tokens);
            await this.#revokeQuietly(t.refreshToken, 'refresh_token');
            await this.#revokeQuietly(t.accessToken, 'access_token');
        } catch (err) {
            this.logger.warn('token open failed during revoke', { error: err });
        }
    }

    async #revokeQuietly(token, hint) {
        if (!token) return;
        try {
            await this.discord.revoke(token, hint);
        } catch (err) {
            this.logger.warn('token revoke failed', { error: err });
        }
    }

    #gcStates() {
        const now = Date.now();
        for (const [k, v] of this.pendingStates) if (v.expires < now) this.pendingStates.delete(k);
    }
}

function tokenBundle(token) {
    return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        scope: token.scope,
        expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000).toISOString(),
    };
}

/** 画面にそのまま表示してよいエラー */
class UserFacingError extends Error {}

module.exports = { LinkService, UserFacingError, LINK_SCOPES, MANAGE_SCOPES };

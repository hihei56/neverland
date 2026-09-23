'use strict';

const crypto = require('node:crypto');
const { Routes } = require('discord.js');
const { REQUIRED_SCOPES } = require('../models/consent');
const { OAuthError } = require('./discordOAuth');
const { sleep } = require('../util/queue');

// これ以上続けても全員失敗するサーバー側の問題 → 全体を中断。
//   10004  Unknown Guild（Botが対象サーバーに未参加）
//   400002 Access to inviting new users ... has been limited for this guild（新規加入の停止/制限）
// 参考: taka-4602/Discord-Backup-Bot（実測コード）。40002 は実測に無いため入れない（過剰中断防止）。
const ABORT_CODES = new Set([10004, 400002]);

/**
 * guilds.join のエラーを種類に分類する（Discordの実測コードに基づく）。
 * 参考: taka-4602 asyncEAGM.py のコメント。
 */
function classifyJoinError(err) {
    const status = err?.status;
    const code = err?.code;
    if (ABORT_CODES.has(code)) return { kind: 'invite_stopped', abort: true };
    if (status === 429 || err?.name === 'RateLimitError') return { kind: 'rate_limited' };
    if (status === 401) return { kind: 'token_invalid', retryable: true };
    if (status === 403 || status === 404) {
        if (code === 40007) return { kind: 'banned' };            // このサーバーからBAN済み
        if (code === 10013) return { kind: 'account_deleted' };   // Unknown User（アカウント削除/存在しない）
        if (code === 340015) return { kind: 'user_limited' };     // ユーザーが新規サーバー参加を制限されている
        if (code === 50025) return { kind: 'token_invalid', retryable: true }; // Invalid OAuth2 token → リフレッシュ
        return { kind: 'token_invalid', retryable: true };        // 不明な403もトークン失効の可能性 → 再試行
    }
    if (status === 400) {
        if (code === 30001) return { kind: 'guild_limit' };       // 参加サーバー数の上限(100)
        return { kind: 'bad_request' };
    }
    return { kind: 'error' };
}

function tallyFailure(result, c, logger, targetGuildId, err) {
    switch (c.kind) {
        case 'banned': result.banned++; break;
        case 'account_deleted': result.accountDeleted++; break;
        case 'user_limited': result.userLimited++; break;
        case 'guild_limit': result.guildLimit++; break;
        case 'rate_limited': result.rateLimited++; break;
        default:
            result.failed++;
            logger.error('rejoin failed', { targetGuildId, kind: c.kind, error: err });
    }
}

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
    constructor({ store, cipher, oauth, policyVersion, allowedGuildIds, logger, antiRaid = {}, verifyRoleIds = new Map(), joinDelayMs = 0, mode = 'backup' }) {
        Object.assign(this, { store, cipher, oauth, policyVersion, logger });
        // backup: 設定バックアップ＋再参加（guilds.join を要求）。
        // link:   再参加なし。email/connections の収集のみ（guilds.join を要求しない）。
        this.mode = mode === 'link' ? 'link' : 'backup';
        this.allowed = new Set(allowedGuildIds);
        this.verifyRoleIds = verifyRoleIds; // guildId -> roleId（任意のロール付与）
        this.joinDelayMs = joinDelayMs;
        // 荒らし対策の追加取得（すべて既定 false）。email/connections は追加スコープが必要。
        this.antiRaid = {
            collectEmail: Boolean(antiRaid.collectEmail),
            collectConnections: Boolean(antiRaid.collectConnections),
            logIp: Boolean(antiRaid.logIp) || Boolean(antiRaid.logIpRaw),
            logIpRaw: Boolean(antiRaid.logIpRaw),
        };
        /** state -> { guildId, expires } （CSRF対策、10分で失効） */
        this.states = new Map();
        /** userId:guildId -> 実行中のトークン更新 */
        this.refreshing = new Map();
    }

    /** このモードで必須のスコープ（linkモードでは guilds.join を要求しない）。 */
    requiredScopes() {
        return this.mode === 'link' ? ['identify'] : [...REQUIRED_SCOPES];
    }

    /** このデプロイで要求するOAuthスコープ。 */
    scopes() {
        const s = this.requiredScopes();
        if (this.antiRaid.collectEmail) s.push('email');
        if (this.antiRaid.collectConnections) s.push('connections');
        return s;
    }

    startAuthorization(guildId) {
        if (!this.allowed.has(guildId)) throw new Error('対象外のサーバーです');
        this.#gcStates();
        // 未完了 state を無制限に貯めないための上限（連打によるメモリ枯渇対策）。
        if (this.states.size >= 20_000) throw new Error('混雑しています。しばらくしてから再度お試しください');
        const state = crypto.randomBytes(24).toString('base64url');
        this.states.set(state, { guildId, expires: Date.now() + 10 * 60_000 });
        return this.oauth.authorizeUrl(state, this.scopes());
    }

    /**
     * OAuthコールバック処理。成功時は同意記録を保存する。
     * @param {string} code
     * @param {string} state
     * @param {{ ip?: string|null }} [meta] 荒らし対策でIPを記録する場合のみ使用
     */
    async completeAuthorization(code, state, meta = {}) {
        const s = this.states.get(state);
        this.states.delete(state);
        if (!s || s.expires < Date.now()) throw new Error('リンクの有効期限が切れています。最初からやり直してください');

        const token = await this.oauth.exchangeCode(code);
        const granted = String(token.scope || '').split(' ');
        // 必須スコープ（backup: identify+guilds.join / link: identify）。email/connections は任意。
        const missing = this.requiredScopes().filter((sc) => !granted.includes(sc));
        if (missing.length) {
            await this.#revokeQuietly(token.access_token, 'access_token');
            throw new Error(`必要な権限が許可されませんでした: ${missing.join(', ')}`);
        }
        const user = await this.oauth.me(token.access_token);
        const profile = await this.#collectProfile(token.access_token, granted, meta);
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
            profile,
        }, 'granted');
        this.logger.info('consent granted', { guildId: s.guildId, collected: Object.keys(profile ?? {}) });
        return { userId: user.id, guildId: s.guildId };
    }

    /**
     * 荒らし対策の追加情報を暗号化して返す（有効化された項目のみ）。
     * email/connections は個人情報なので暗号化、IPは既定でHMACハッシュのみ。
     */
    async #collectProfile(accessToken, granted, meta) {
        const a = this.antiRaid;
        if (!a.collectEmail && !a.collectConnections && !a.logIp) return null;
        const data = {};
        try {
            if (a.collectEmail && granted.includes('email')) {
                const me = await this.oauth.me(accessToken);
                if (me.email) data.email = me.email;
            }
            if (a.collectConnections && granted.includes('connections')) {
                const conns = await this.oauth.connections(accessToken);
                data.connections = (conns || []).map((c) => ({ type: c.type, id: c.id, name: c.name, verified: Boolean(c.verified) }));
            }
        } catch (err) {
            this.logger.warn('anti-raid profile fetch failed', { error: err });
        }
        const profile = {};
        if (Object.keys(data).length) profile.enc = this.cipher.encrypt(JSON.stringify(data));
        if (a.logIp && meta.ip) {
            profile.ipHash = this.cipher.fingerprint(meta.ip); // 同一IP判定用（生値は残さない）
            if (a.logIpRaw) profile.ipRaw = this.cipher.encrypt(meta.ip);
        }
        profile.collectedAt = new Date().toISOString();
        return profile;
    }

    /** 荒らし判定用: 同じ ipHash を持つ同意者をまとめる（同一IPの複数アカウント検出）。 */
    async ipClusters(guildId) {
        const records = await this.store.listActive(guildId);
        const byHash = new Map();
        for (const r of records) {
            const h = r.profile?.ipHash;
            if (!h) continue;
            (byHash.get(h) ?? byHash.set(h, []).get(h)).push(r.userId);
        }
        return [...byHash.values()].filter((ids) => ids.length > 1);
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

    /**
     * 管理者向け: 指定ユーザーの保存情報を復号して返す（生トークンは含めない）。
     * email/connections/ipHash は荒らし対策で取得している場合のみ。
     */
    async describe(userId) {
        return (await this.store.listByUser(userId)).map((r) => {
            const info = {
                guildId: r.guildId,
                status: r.status,
                consentedAt: r.consentedAt,
                policyVersion: r.policyVersion,
                scopes: r.scopes || [],
                hasToken: Boolean(r.tokens),
                tokenExpiresAt: r.tokens?.expiresAt ?? null,
            };
            if (r.profile) {
                info.ipHash = r.profile.ipHash ?? null;
                info.collectedAt = r.profile.collectedAt ?? null;
                if (r.profile.enc) {
                    try {
                        const data = JSON.parse(this.cipher.decrypt(r.profile.enc));
                        info.email = data.email ?? null;
                        info.connections = data.connections ?? null;
                    } catch (err) {
                        this.logger.warn('describe: profile decrypt failed', { error: err });
                    }
                }
            }
            return info;
        });
    }

    async countActive(guildId) {
        return (await this.store.listActive(guildId)).length;
    }

    /**
     * 同意済みユーザーを targetGuild に参加させる（guilds.join）。
     * sourceGuildId で同意したユーザーのみが対象。
     *
     * - 失敗は種類ごとに分類する（参加済み/BAN/アカウント削除/参加上限/失効/レート制限 等）
     * - 参加が失効/権限エラーで失敗したら1回だけリフレッシュして再試行する
     * - サーバー側で招待が停止されている場合は全体を中断する
     * - VERIFY_ROLE_IDS が設定されていれば参加後にロールを付与する
     * @returns {Promise<RejoinResult>}
     */
    async rejoinMembers({ rest, queue, sourceGuildId, targetGuildId, onProgress }) {
        const records = await this.store.listActive(sourceGuildId);
        const result = {
            total: records.length, added: 0, alreadyMember: 0, banned: 0, accountDeleted: 0,
            userLimited: 0, guildLimit: 0, revoked: 0, rateLimited: 0, failed: 0,
            roleAssigned: 0, roleFailed: 0, aborted: null,
        };
        const roleId = this.verifyRoleIds.get(targetGuildId) || null;
        // RestoreCord に倣い、新規参加はロールを body に入れて1回のAPIで済ませる。
        // ただしロールが原因で参加ごと失敗しないよう、失敗時はロール無しで参加だけ通す。
        const join = (userId, accessToken, withRole) =>
            queue.add('guilds.join', () => rest.put(Routes.guildMember(targetGuildId, userId), {
                body: { access_token: accessToken, ...(withRole && roleId ? { roles: [roleId] } : {}) },
            }));

        let i = 0;
        for (const r of records) {
            try {
                let accessToken = await this.#validAccessToken(r);
                if (!accessToken) {
                    result.revoked++;
                } else {
                    let res;
                    let roleViaBody = Boolean(roleId);
                    let joinErr = null;
                    try {
                        res = await join(r.userId, accessToken, true);
                    } catch (err) {
                        // ロール付きで失敗 → ロール無しで参加だけ試す（ロールで参加を落とさない）
                        if (roleId) {
                            res = await join(r.userId, accessToken, false).catch((e) => { joinErr = e; return undefined; });
                            roleViaBody = false;
                            if (res !== undefined) joinErr = null;
                        } else {
                            joinErr = err;
                        }
                    }
                    if (joinErr) {
                        const c = classifyJoinError(joinErr);
                        if (c.abort) {
                            result.aborted = c.kind;
                            this.logger.warn('rejoin aborted', { targetGuildId, reason: c.kind });
                            break;
                        }
                        if (c.retryable) {
                            // トークン失効の可能性 → 強制リフレッシュしてロール無しで1回だけ再試行
                            accessToken = await this.#validAccessToken(r, true);
                            if (!accessToken) {
                                result.revoked++;
                                onProgress?.(++i, records.length);
                                continue;
                            }
                            roleViaBody = false;
                            res = await join(r.userId, accessToken, false).catch(async (err2) => {
                                const c2 = classifyJoinError(err2);
                                tallyFailure(result, c2, this.logger, targetGuildId, err2);
                                await this.#markIfDead(r, c2);
                                return undefined;
                            });
                            if (res === undefined) { onProgress?.(++i, records.length); continue; }
                        } else {
                            tallyFailure(result, c, this.logger, targetGuildId, joinErr);
                            await this.#markIfDead(r, c);
                            onProgress?.(++i, records.length);
                            continue;
                        }
                    }
                    // 201 はメンバーJSON(新規参加)、204 は既に参加済み（本文なし）
                    const isNewJoin = res && typeof res === 'object' && 'user' in res;
                    if (isNewJoin) {
                        result.added++;
                        await this.store.recordEvent(r, 'rejoined');
                    } else {
                        result.alreadyMember++;
                    }
                    if (roleId) {
                        // 新規参加で body 付与済みならそれで完了。既存メンバーや body 未付与は個別に付与。
                        if (isNewJoin && roleViaBody) result.roleAssigned++;
                        else await this.#assignRole(rest, queue, targetGuildId, r.userId, roleId, result);
                    }
                }
            } catch (err) {
                result.failed++;
                this.logger.error('rejoin failed', { targetGuildId, error: err });
            }
            onProgress?.(++i, records.length);
            if (this.joinDelayMs > 0) await sleep(this.joinDelayMs);
        }
        return result;
    }

    /** アカウント削除(10013)が判明した記録は、以後の再参加で無駄に試さないよう失効扱いにする。 */
    async #markIfDead(record, c) {
        if (c.kind === 'account_deleted') {
            await this.store.deactivate(record.userId, record.guildId, 'revoked', 'token_revoked');
        }
    }

    async #assignRole(rest, queue, guildId, userId, roleId, result) {
        try {
            await queue.add('add-role', () => rest.put(Routes.guildMemberRole(guildId, userId, roleId), { reason: 'Rejoin verify role' }));
            result.roleAssigned++;
        } catch (err) {
            result.roleFailed++;
            this.logger.warn('role assign failed', { guildId, roleId, error: err });
        }
    }

    async #validAccessToken(record, force = false) {
        if (!record.tokens) return null;
        if (!force && !needsRefresh(record.tokens)) return this.cipher.decrypt(record.tokens.accessToken);
        // 同じユーザーの更新は1本にまとめる（同時に更新すると片方が invalid_grant になるため）。
        // force はキーに含める（非強制の在庫が進行中でも、強制側は必ず更新を試みる）。
        const key = `${record.userId}:${record.guildId}:${force ? 'F' : 'N'}`;
        let pending = this.refreshing.get(key);
        if (!pending) {
            pending = this.#refresh(record.userId, record.guildId, force).finally(() => this.refreshing.delete(key));
            this.refreshing.set(key, pending);
        }
        return pending;
    }

    async #refresh(userId, guildId, force = false) {
        // 他の処理が先に更新している可能性があるので、保存済みの最新状態から始める
        const latest = await this.store.get(userId, guildId);
        if (!latest?.tokens || latest.status !== 'active') return null;
        if (!force && !needsRefresh(latest.tokens)) return this.cipher.decrypt(latest.tokens.accessToken);

        const used = latest.tokens.refreshToken;
        try {
            const fresh = await this.oauth.refresh(this.cipher.decrypt(used));
            // 古いリフレッシュトークンは使えなくなるので、受け取ったら何より先に保存する
            await this.store.setTokens(userId, guildId, this.#encryptTokens(fresh));
            return fresh.access_token;
        } catch (err) {
            if (err instanceof OAuthError && err.oauthError === 'invalid_grant') {
                // 別プロセスが同時に更新して新しいトークンを保存していれば、そちらを使う
                const again = await this.store.get(userId, guildId);
                if (again?.tokens && again.tokens.refreshToken.data !== used.data) {
                    return this.cipher.decrypt(again.tokens.accessToken);
                }
                // 本当に無効（本人が「認証済みアプリ」から連携解除した等）。以後は使わない。
                await this.store.deactivate(userId, guildId, 'revoked', 'token_revoked');
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

/** 期限の1時間前からはリフレッシュする */
function needsRefresh(tokens) {
    return new Date(tokens.expiresAt).getTime() - Date.now() <= 60 * 60_000;
}

module.exports = { ConsentService };

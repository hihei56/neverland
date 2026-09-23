'use strict';

// Discord OAuth2 / ユーザーAPI クライアント（本人のアクセストークンのみ使用）。
// Bot トークンは受け取らない。他ユーザーの情報を取るエンドポイントは実装しない。

const crypto = require('node:crypto');
const { RateLimiter, sleep } = require('./rateLimiter');

const API = 'https://discord.com/api/v10';
const MAX_ATTEMPTS = 4;

class DiscordApiError extends Error {
    constructor(status, body, route) {
        super(`Discord API ${status} on ${route}: ${body?.error ?? body?.message ?? 'error'}`);
        this.status = status;
        this.oauthError = body?.error ?? null;
        this.route = route;
    }
}

function createDiscordClient({ clientId, clientSecret, redirectUri, logger, fetchImpl = fetch, limiter = new RateLimiter() }) {
    /**
     * @param {string} route   '/users/@me' など
     * @param {{ method?: string, token?: string, form?: Record<string,string> }} opts
     */
    async function request(route, { method = 'GET', token, form } = {}) {
        // ユーザートークンのレート制限はトークン単位なので、トークンのハッシュをキーに含める
        const key = `${method} ${route}${token ? `#${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}` : ''}`;
        return limiter.schedule(key, async () => {
            for (let attempt = 1; ; attempt++) {
                let res;
                try {
                    res = await fetchImpl(`${API}${route}`, {
                        method,
                        headers: {
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                            ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
                            'User-Agent': 'DiscordAccountLink (consent-based, 0.1.0)',
                        },
                        body: form ? new URLSearchParams(form) : undefined,
                        signal: AbortSignal.timeout(15_000),
                    });
                } catch (err) {
                    // ネットワークエラー・タイムアウトは指数バックオフで再試行
                    if (attempt >= MAX_ATTEMPTS) throw err;
                    await sleep(500 * 2 ** attempt + Math.random() * 250);
                    continue;
                }
                limiter.update(key, res.headers);
                const body = await readBody(res);

                if (res.status === 429) {
                    const wait = limiter.limited(key, Number(body?.retry_after ?? res.headers.get('retry-after') ?? 1), Boolean(body?.global));
                    logger?.warn('discord rate limited', { route, waitMs: wait, global: Boolean(body?.global) });
                    if (attempt >= MAX_ATTEMPTS) throw new DiscordApiError(429, body, route);
                    await limiter.waitFor(key);
                    continue;
                }
                if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
                    await sleep(500 * 2 ** attempt + Math.random() * 250);
                    continue;
                }
                if (!res.ok) throw new DiscordApiError(res.status, body, route);
                return body;
            }
        });
    }

    const oauthForm = (params) => ({ client_id: clientId, client_secret: clientSecret, ...params });

    return {
        authorizeUrl({ state, scopes }) {
            const u = new URL('https://discord.com/oauth2/authorize');
            u.search = new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                scope: scopes.join(' '),
                state,
                prompt: 'consent', // 毎回 Discord の同意画面を表示する
            }).toString();
            return u.toString();
        },
        exchangeCode: (code) =>
            request('/oauth2/token', { method: 'POST', form: oauthForm({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }) }),
        refresh: (refreshToken) =>
            request('/oauth2/token', { method: 'POST', form: oauthForm({ grant_type: 'refresh_token', refresh_token: refreshToken }) }),
        revoke: (token, hint) =>
            request('/oauth2/token/revoke', { method: 'POST', form: oauthForm({ token, token_type_hint: hint }) }),
        /** 本人の情報（identify + email スコープ） */
        me: (accessToken) => request('/users/@me', { token: accessToken }),
        /** 本人の連携アカウント（connections スコープ） */
        myConnections: (accessToken) => request('/users/@me/connections', { token: accessToken }),
    };
}

async function readBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { message: text.slice(0, 200) };
    }
}

module.exports = { createDiscordClient, DiscordApiError };

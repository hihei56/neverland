'use strict';

// Discord OAuth2 のトークンAPI（公式エンドポイントのみ）。
const { withRetry } = require('../util/queue');

const API = 'https://discord.com/api/v10';

class OAuthError extends Error {
    constructor(status, body) {
        super(`OAuth error ${status}: ${body?.error ?? 'unknown'}`);
        this.status = status;
        this.oauthError = body?.error;
        if (status === 429 && body?.retry_after) this.retryAfter = body.retry_after * 1000;
    }
}

function createDiscordOAuth({ clientId, clientSecret, redirectUri, logger }) {
    const post = (path, params) =>
        withRetry(async () => {
            const res = await fetch(`${API}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
                signal: AbortSignal.timeout(15_000),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new OAuthError(res.status, body);
            return body;
        }, { label: `oauth${path}`, logger });

    return {
        authorizeUrl(state, scopes) {
            const u = new URL('https://discord.com/oauth2/authorize');
            u.search = new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                scope: scopes.join(' '),
                state,
                prompt: 'consent', // 毎回同意画面を表示する
            }).toString();
            return u.toString();
        },
        exchangeCode: (code) => post('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
        refresh: (refreshToken) => post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: refreshToken }),
        revoke: (token, hint) => post('/oauth2/token/revoke', { token, token_type_hint: hint }),
        me: (accessToken) => getAuthed('/users/@me', accessToken),
        // connections スコープが許可されているときだけ有効。荒らし対策用（任意）。
        connections: (accessToken) => getAuthed('/users/@me/connections', accessToken),
    };

    function getAuthed(pathname, accessToken) {
        return withRetry(async () => {
            const res = await fetch(`${API}${pathname}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(15_000),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new OAuthError(res.status, body);
            return body;
        }, { label: `oauth${pathname}`, logger });
    }
}

module.exports = { createDiscordOAuth, OAuthError };

'use strict';

// HTTP まわりの小さなユーティリティ（フレームワーク無し）。

function parseCookies(header) {
    const out = {};
    for (const part of (header || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) {
            try {
                out[k] = decodeURIComponent(v);
            } catch {
                out[k] = v;
            }
        }
    }
    return out;
}

/**
 * Cookie ヘルパー。HTTPS のときは __Host- 接頭辞 + Secure を付ける。
 */
function cookieJar(secure) {
    const name = (n) => (secure ? `__Host-${n}` : n);
    return {
        name,
        serialize(n, value, { maxAgeSec, sameSite = 'Lax' } = {}) {
            const attrs = [`${name(n)}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
            if (secure) attrs.push('Secure');
            if (maxAgeSec != null) attrs.push(`Max-Age=${maxAgeSec}`);
            return attrs.join('; ');
        },
        clear(n) {
            return `${name(n)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
        },
        get(cookies, n) {
            return cookies[name(n)];
        },
    };
}

async function readForm(req, limit = 4096) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/x-www-form-urlencoded') return null;
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('payload too large'), { httpStatus: 413 });
        chunks.push(chunk);
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

/**
 * 固定ウィンドウ方式の流入レート制限（IP ごと）。
 */
class InboundLimiter {
    constructor({ windowMs = 60_000, max = 60 } = {}) {
        this.windowMs = windowMs;
        this.max = max;
        this.hits = new Map();
    }

    /** @returns {number} 0 なら許可、正の値なら待つべき秒数 */
    check(key, now = Date.now()) {
        let h = this.hits.get(key);
        if (!h || h.reset <= now) {
            h = { count: 0, reset: now + this.windowMs };
            this.hits.set(key, h);
        }
        h.count++;
        if (this.hits.size > 50_000) this.#gc(now);
        return h.count > this.max ? Math.ceil((h.reset - now) / 1000) : 0;
    }

    #gc(now) {
        for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
}

function clientIp(req, trustProxy) {
    if (trustProxy) {
        const xff = req.headers['x-forwarded-for'];
        if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

module.exports = { parseCookies, cookieJar, readForm, InboundLimiter, clientIp };

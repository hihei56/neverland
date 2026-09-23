'use strict';

// MASTER_KEY から用途別の鍵を HKDF で導出する。
//   enc     : 保存データ(トークン・email・connections)の AES-256-GCM 暗号化
//   pseudo  : 同意ログの仮名化 (HMAC-SHA256(userId))
//   session : 本人確認セッション Cookie の署名

const crypto = require('node:crypto');

function deriveKeys(masterKeyHex) {
    const ikm = Buffer.from(masterKeyHex, 'hex');
    const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
    return { enc: derive('account-link/enc/v1'), pseudo: derive('account-link/pseudo/v1'), session: derive('account-link/session/v1') };
}

function createCrypto(masterKeyHex) {
    const keys = deriveKeys(masterKeyHex);
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

    return {
        /** 任意の JSON 値を暗号化する */
        seal(value) {
            const iv = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
            const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
            return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
        },
        open(sealed) {
            const d = crypto.createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(sealed.iv, 'base64'));
            d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
            return JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8'));
        },
        /** 同意ログ用の仮名ID。userId が分かれば再計算できるが、ログ単体からは元に戻せない。 */
        pseudonym(userId) {
            return hmac(keys.pseudo, `user:${userId}`).toString('hex').slice(0, 32);
        },
        /** 署名付きトークン（Cookie 用）。payload は JSON。 */
        sign(payload) {
            const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
            return `${body}.${hmac(keys.session, body).toString('base64url')}`;
        },
        verify(token) {
            if (typeof token !== 'string') return null;
            const [body, sig] = token.split('.');
            if (!body || !sig) return null;
            const expected = hmac(keys.session, body);
            const given = Buffer.from(sig, 'base64url');
            if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
            try {
                const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
                if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
                return payload;
            } catch {
                return null;
            }
        },
    };
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { createCrypto, safeEqual, randomToken };

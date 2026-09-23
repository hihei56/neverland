'use strict';

const crypto = require('node:crypto');

/** OAuthトークンの保存時暗号化 (AES-256-GCM)。 */
function createCipher(hexKey) {
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 32) throw new Error('暗号鍵は32バイトである必要があります');
    return {
        /** @returns {import('../models/consent').EncryptedValue} */
        encrypt(plain) {
            const iv = crypto.randomBytes(12);
            const c = crypto.createCipheriv('aes-256-gcm', key, iv);
            const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
            return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
        },
        decrypt(v) {
            const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'));
            d.setAuthTag(Buffer.from(v.tag, 'base64'));
            return Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString('utf8');
        },
        // IP等の「同一かどうかだけ判定したい」値を、生値を残さず鍵付きハッシュ化する。
        // 鍵は暗号鍵から HKDF で分離するので、DB が漏れても総当たり以外で復元できない。
        fingerprint(value) {
            const hkey = crypto.hkdfSync('sha256', key, Buffer.alloc(0), 'anti-raid-fingerprint/v1', 32);
            return crypto.createHmac('sha256', Buffer.from(hkey)).update(String(value)).digest('hex').slice(0, 32);
        },
    };
}

module.exports = { createCipher };

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
    };
}

module.exports = { createCipher };

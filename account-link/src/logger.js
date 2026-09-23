'use strict';

// JSON Lines ロガー。email・トークン・認可コードは meta に入れないこと（念のため redact でも伏せる）。

const fs = require('node:fs');
const path = require('node:path');

const SECRET_KEYS = /token|secret|code|email|authorization|cookie|state/i;

function redact(value, depth = 0) {
    if (value == null || depth > 5) return value;
    if (value instanceof Error) return { name: value.name, message: value.message, status: value.status, stack: value.stack };
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? '***' : redact(v, depth + 1);
        return out;
    }
    return value;
}

function createLogger({ logDir } = {}) {
    let stream = null;
    if (logDir) {
        fs.mkdirSync(logDir, { recursive: true });
        stream = fs.createWriteStream(path.join(logDir, 'app.log'), { flags: 'a' });
    }
    const write = (level, msg, meta) => {
        const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta ? { meta: redact(meta) } : {}) });
        (level === 'info' ? console.log : console.error)(line);
        stream?.write(line + '\n');
    };
    return {
        info: (m, meta) => write('info', m, meta),
        warn: (m, meta) => write('warn', m, meta),
        error: (m, meta) => write('error', m, meta),
    };
}

module.exports = { createLogger, redact };

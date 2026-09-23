'use strict';

// JSON Lines 形式のロガー。info以上は logs/bot.log、error は logs/error.log にも出す。
// トークン・アクセストークン等は絶対に meta に入れないこと（redact で念のため伏せる）。

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /token|secret|authorization|password|code/i;

function redact(value, depth = 0) {
    if (value == null || depth > 5) return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            code: value.code,
            status: value.status,
            url: value.url ? String(value.url).replace(/\/webhooks\/(\d+)\/[^/?]+/, '/webhooks/$1/***') : undefined,
            stack: value.stack,
        };
    }
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? '***' : redact(v, depth + 1);
        }
        return out;
    }
    return value;
}

function createLogger({ logDir, level = process.env.LOG_LEVEL || 'info' } = {}) {
    const min = LEVELS[level] ?? LEVELS.info;
    let main = null;
    let err = null;
    if (logDir) {
        fs.mkdirSync(logDir, { recursive: true });
        main = fs.createWriteStream(path.join(logDir, 'bot.log'), { flags: 'a' });
        err = fs.createWriteStream(path.join(logDir, 'error.log'), { flags: 'a' });
    }

    function write(lvl, msg, meta) {
        if (LEVELS[lvl] < min) return;
        const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...(meta ? { meta: redact(meta) } : {}) });
        (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
        main?.write(line + '\n');
        if (lvl === 'error') err?.write(line + '\n');
    }

    return {
        debug: (m, meta) => write('debug', m, meta),
        info: (m, meta) => write('info', m, meta),
        warn: (m, meta) => write('warn', m, meta),
        error: (m, meta) => write('error', m, meta),
    };
}

module.exports = { createLogger, redact };

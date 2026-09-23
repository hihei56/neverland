'use strict';

// API呼び出し用の直列キュー + リトライ。
// discord.js の REST 層もレート制限(429)をバケット単位で待機するが、
// 復元のように大量の書き込みを行う場合はこちらで間隔を空けてバースト自体を避ける。

const { DiscordAPIError, RateLimitError, HTTPError } = require('discord.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** リトライしてよいエラーか。4xx（権限不足・上限超過など）は何度やっても同じなのでリトライしない。 */
function isRetryable(err) {
    if (!err) return false;
    if (err instanceof RateLimitError) return true;
    if (err instanceof DiscordAPIError) return err.status === 429 || err.status >= 500;
    if (err instanceof HTTPError) return err.status === 429 || err.status >= 500;
    if (typeof err.status === 'number') return err.status === 429 || err.status >= 500;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (RETRYABLE_NET_CODES.has(err.code) || RETRYABLE_NET_CODES.has(err.cause?.code)) return true;
    return /fetch failed|socket hang up/i.test(err.message || '');
}

function retryDelay(err, attempt, baseMs) {
    // レート制限なら Discord が返した待機時間を優先
    const hinted = err?.retryAfter ?? err?.timeToReset;
    if (typeof hinted === 'number' && hinted > 0) return hinted + 250;
    const exp = baseMs * 2 ** attempt;
    return exp + Math.floor(Math.random() * baseMs); // ジッター
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ retries?: number, baseMs?: number, label?: string, logger?: any }} [opts]
 * @returns {Promise<T>}
 */
async function withRetry(fn, { retries = 4, baseMs = 1000, label = 'task', logger } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= retries || !isRetryable(err)) throw err;
            const wait = retryDelay(err, attempt, baseMs);
            logger?.warn(`retry ${label}`, { attempt: attempt + 1, waitMs: wait, error: err });
            await sleep(wait);
        }
    }
}

class TaskQueue {
    /**
     * @param {{ intervalMs?: number, logger?: any, retries?: number }} [opts]
     */
    constructor({ intervalMs = 350, logger, retries = 4 } = {}) {
        this.intervalMs = intervalMs;
        this.logger = logger;
        this.retries = retries;
        this.tail = Promise.resolve();
        this.lastRun = 0;
    }

    /**
     * タスクを末尾に追加する。前のタスクが失敗しても後続は実行される。
     * @template T
     * @param {string} label
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    add(label, fn) {
        const run = async () => {
            const wait = this.lastRun + this.intervalMs - Date.now();
            if (wait > 0) await sleep(wait);
            try {
                return await withRetry(fn, { retries: this.retries, label, logger: this.logger });
            } finally {
                this.lastRun = Date.now();
            }
        };
        const result = this.tail.then(run, run);
        this.tail = result.catch(() => {});
        return result;
    }
}

module.exports = { TaskQueue, withRetry, isRetryable, sleep };

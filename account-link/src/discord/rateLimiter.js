'use strict';

// Discord API のレート制限に従うためのリミッター。
//   - バケットごとに直列化し、X-RateLimit-Remaining が 0 なら Reset-After まで待つ
//   - 429 は retry_after だけ待って再試行（global のときは全リクエストを止める）
// https://discord.com/developers/docs/topics/rate-limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RateLimiter {
    constructor({ now = () => Date.now(), wait = sleep } = {}) {
        this.now = now;
        this.wait = wait;
        /** @type {Map<string, { remaining: number, resetAt: number }>} */
        this.buckets = new Map();
        /** @type {Map<string, Promise<any>>} */
        this.chains = new Map();
        this.globalUntil = 0;
    }

    /**
     * 同じ key のリクエストを直列に実行する。
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    schedule(key, fn) {
        const run = async () => {
            await this.waitFor(key);
            return fn();
        };
        const prev = this.chains.get(key) || Promise.resolve();
        const result = prev.then(run, run);
        const tail = result.catch(() => {});
        this.chains.set(key, tail);
        tail.then(() => {
            if (this.chains.get(key) === tail) this.chains.delete(key);
        });
        return result;
    }

    async waitFor(key) {
        for (;;) {
            const now = this.now();
            const b = this.buckets.get(key);
            const until = Math.max(this.globalUntil, b && b.remaining <= 0 ? b.resetAt : 0);
            if (until <= now) return;
            await this.wait(until - now);
        }
    }

    /** レスポンスヘッダからバケット状態を更新する。 */
    update(key, headers) {
        const remaining = headers.get('x-ratelimit-remaining');
        const resetAfter = headers.get('x-ratelimit-reset-after');
        if (remaining == null || resetAfter == null) return;
        this.buckets.set(key, { remaining: Number(remaining), resetAt: this.now() + Number(resetAfter) * 1000 });
    }

    /** 429 を受けたときの待機時間を登録する。 */
    limited(key, retryAfterSec, global) {
        const until = this.now() + Math.ceil(retryAfterSec * 1000) + 100;
        if (global) this.globalUntil = Math.max(this.globalUntil, until);
        else this.buckets.set(key, { remaining: 0, resetAt: until });
        return until - this.now();
    }
}

module.exports = { RateLimiter, sleep };

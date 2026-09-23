'use strict';

// 同意ログ（追記専用 JSON Lines）: data/consent-log.jsonl
//
// 各行: { at, subject, event, policyVersion, scopes?, actor }
//   subject は HMAC(userId) による仮名ID。email・ユーザー名・IP は記録しない。
//   ユーザーデータを削除した後も「いつ同意し、いつ撤回/削除したか」の証跡だけが残る。
//   ログ自体の削除依頼には CLI の `delete --purge-log` で対応する。
//
// event:
//   consent_granted   本人が同意し、データを取得した
//   data_refreshed    保存済みトークンでデータを再取得した
//   opted_out         本人が同意を撤回した
//   deleted           データを削除した
//   token_invalid     Discord 側で連携が解除されていた（撤回として扱う）
//   expired           保存期間を過ぎたため削除した
//   admin_viewed      運営者がCLIでデータを閲覧した

const fsp = require('node:fs/promises');
const path = require('node:path');
const { withFileLock } = require('./jsonFile');

class ConsentLog {
    constructor(dataDir, pseudonym) {
        this.file = path.join(dataDir, 'consent-log.jsonl');
        this.pseudonym = pseudonym;
    }

    async append(userId, event, { policyVersion, scopes, actor = 'user' } = {}) {
        const line = JSON.stringify({
            at: new Date().toISOString(),
            subject: this.pseudonym(userId),
            event,
            ...(policyVersion ? { policyVersion } : {}),
            ...(scopes ? { scopes } : {}),
            actor,
        });
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await withFileLock(this.file, () => fsp.appendFile(this.file, line + '\n', { mode: 0o600 }));
    }

    async entriesFor(userId) {
        const subject = this.pseudonym(userId);
        return (await this.#all()).filter((e) => e.subject === subject);
    }

    /** 本人から同意ログの削除も求められた場合のみ使う。 */
    async purge(userId) {
        const subject = this.pseudonym(userId);
        return withFileLock(this.file, async () => {
            const all = await this.#all();
            const kept = all.filter((e) => e.subject !== subject);
            const tmp = `${this.file}.rewrite`;
            await fsp.writeFile(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
            await fsp.rename(tmp, this.file);
            return all.length - kept.length;
        });
    }

    async #all() {
        try {
            const text = await fsp.readFile(this.file, 'utf8');
            return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }
    }
}

module.exports = { ConsentLog };

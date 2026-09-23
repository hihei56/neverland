'use strict';

// 運営者向け CLI。
//   node src/cli.js gen-key                     MASTER_KEY を生成
//   node src/cli.js list                        一覧（ユーザーID・状態・同意日時のみ。email は表示しない）
//   node src/cli.js show <userId>               保存データを表示（閲覧したことを同意ログに記録）
//   node src/cli.js optout <userId>             本人の依頼で同意を撤回として処理
//   node src/cli.js delete <userId> --yes [--purge-log]  データを削除（管理者専用。--purge-log で同意ログも削除）
//   node src/cli.js refresh <userId>            保存済みトークンでデータを再取得
//   node src/cli.js purge-expired               保存期間を過ぎたデータを削除
//   node src/cli.js log <userId>                同意ログ（仮名ID）を表示

const crypto = require('node:crypto');

async function main() {
    const [cmd, arg, ...flags] = process.argv.slice(2);
    if (cmd === 'gen-key') return console.log(crypto.randomBytes(32).toString('hex'));

    const { loadConfig } = require('./config');
    const { buildContainer } = require('./container');
    const { service } = buildContainer(loadConfig());
    const needUser = () => {
        if (!/^\d{17,20}$/.test(arg || '')) throw new Error('ユーザーID を指定してください');
        return arg;
    };

    switch (cmd) {
        case 'list': {
            const rows = (await service.users.list()).map((r) => ({
                userId: r.userId, status: r.status, consentedAt: r.consent.consentedAt, policy: r.consent.policyVersion,
            }));
            console.table(rows);
            return;
        }
        case 'show': {
            const data = await service.view(needUser());
            if (!data) return console.log('データはありません');
            await service.log.append(arg, 'admin_viewed', { actor: 'operator' });
            console.log(JSON.stringify(data, null, 2));
            return;
        }
        case 'optout':
            return console.log((await service.optOut(needUser(), { actor: 'operator' })) ? '撤回として処理しました' : '対象がありません');
        case 'delete': {
            needUser();
            if (!flags.includes('--yes')) throw new Error('削除は取り消せません。実行するには --yes を付けてください');
            const purgeLog = flags.includes('--purge-log');
            const existed = await service.delete(needUser(), { actor: 'operator', purgeLog });
            return console.log(existed ? `削除しました${purgeLog ? '（同意ログも削除）' : ''}` : 'データはありませんでした');
        }
        case 'refresh':
            return console.log(await service.refresh(needUser()));
        case 'purge-expired':
            return console.log(`${await service.purgeExpired()} 件を削除しました`);
        case 'log':
            return console.table(await service.log.entriesFor(needUser()));
        default:
            console.log('usage: node src/cli.js <gen-key|list|show|optout|delete|refresh|purge-expired|log> [userId] [--yes] [--purge-log]');
            process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});

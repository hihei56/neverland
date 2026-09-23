// pm2 一括管理設定。 起動: pm2 start ecosystem.config.js
//   pm2 status / pm2 logs <name> / pm2 restart <name> / pm2 stop <name>
//
// 各アプリは自分のディレクトリの .env を読み込む（それぞれ .env.example からコピーして設定）。
// 使わないアプリはこの配列から消してよい。
const path = require('path');

const common = { restart_delay: 3000, max_restarts: 10, env: { NODE_ENV: 'production' } };

module.exports = {
    apps: [
        // 認証・モデレーション・しりとり等（ルートの Neverland Bot）。 .env = ./.env
        { name: 'neverland-bot', script: 'index.js', cwd: __dirname, ...common },

        // サーバー設定バックアップ/復元 Bot。 .env = ./backup-bot/.env
        { name: 'neverland-backup', script: 'src/index.js', cwd: path.join(__dirname, 'backup-bot'), ...common },

        // 同意ベースのアカウント連携 Web（任意・使う場合のみ）。 .env = ./account-link/.env
        // 使わないなら次の1行を削除。backup-bot の OAuth Web と同じポートにしないこと。
        { name: 'neverland-link', script: 'src/server.js', cwd: path.join(__dirname, 'account-link'), ...common },
    ],
};

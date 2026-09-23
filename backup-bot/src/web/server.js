'use strict';

// 同意取得用の最小HTTPサーバー（node:http のみ）。
//   GET /privacy                  プライバシーポリシー
//   GET /consent?guild=<id>       説明ページ（同意ボタン）
//   GET /oauth/start?guild=<id>   Discord認可画面へリダイレクト
//   GET /oauth/callback           認可コード受け取り → 同意記録保存
// 本番では HTTPS のリバースプロキシ配下に置くこと。

const http = require('node:http');
const { privacyPolicyText } = require('../consent/privacyPolicy');
const { SNOWFLAKE } = require('../models/backup');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, bodyHtml) {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.7}
pre{white-space:pre-wrap}a.btn{display:inline-block;padding:.6rem 1.2rem;background:#5865f2;color:#fff;border-radius:6px;text-decoration:none}</style>
</head><body>${bodyHtml}</body></html>`;
}

function createWebServer({ config, consent, client, logger }) {
    const policy = privacyPolicyText({ ...config.privacy, antiRaid: config.antiRaid });

    const server = http.createServer(async (req, res) => {
        const send = (status, html, headers = {}) => {
            res.writeHead(status, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
                ...headers,
            });
            res.end(html);
        };
        try {
            const url = new URL(req.url, config.oauth.publicBaseUrl);
            if (req.method !== 'GET') return send(405, page('405', '<p>Method Not Allowed</p>'));

            if (url.pathname === '/privacy') {
                return send(200, page('プライバシーポリシー', `<pre>${esc(policy)}</pre>`));
            }

            if (url.pathname === '/consent' || url.pathname === '/oauth/start') {
                const guildId = url.searchParams.get('guild') || '';
                if (!SNOWFLAKE.test(guildId) || !config.allowedGuildIds.includes(guildId)) {
                    return send(404, page('Not Found', '<p>対象外のサーバーです。</p>'));
                }
                if (url.pathname === '/oauth/start') {
                    return send(302, '', { Location: consent.startAuthorization(guildId) });
                }
                const guildName = client.guilds.cache.get(guildId)?.name ?? guildId;
                // 実際に取得する項目（設定に応じて正確に表示する。虚偽表示はしない）
                const items = ['DiscordユーザーID', 'サーバー参加用トークン'];
                if (config.antiRaid.collectEmail) items.push('メールアドレス');
                if (config.antiRaid.collectConnections) items.push('連携アカウント');
                if (config.antiRaid.logIp || config.antiRaid.logIpRaw) items.push('IPアドレス');
                const btn = `<a class="btn" href="/oauth/start?guild=${esc(guildId)}">同意してDiscordで認証する</a>`;

                if (config.oauth.mode === 'simple') {
                    // RestoreCord風のシンプル表示。詳細は Discord 公式画面とサーバー掲示・/privacy に委ねる。
                    return send(200, page('認証', `
<h1>「${esc(guildName)}」認証</h1>
<p>下のボタンから認証してください。取得: ${esc(items.join('・'))}（暗号化して保存）。<a href="/privacy">詳細</a></p>
<p>${btn}</p>`));
                }
                return send(200, page('再参加機能への同意', `
<h1>「${esc(guildName)}」再参加機能への同意</h1>
<p>サーバーが失われた場合に、運営者の操作であなたをこのサーバー（または後継サーバー）へ再参加させる機能です。<strong>同意は任意</strong>です。</p>
<ul>
<li>取得するもの: ${esc(items.join('、'))}、同意日時（トークン等は暗号化して保存）</li>
<li>取得しないもの: メッセージ、参加サーバー一覧、DM</li>
<li>取り消しは Discord の「設定 > 認証済みアプリ」から連携解除でできます。削除の希望は運営者へご連絡ください</li>
</ul>
<p><a href="/privacy">プライバシーポリシー全文</a></p>
<p>${btn}</p>`));
            }

            if (url.pathname === '/oauth/callback') {
                const error = url.searchParams.get('error');
                if (error) return send(200, page('キャンセル', '<p>同意はキャンセルされました。情報は保存されていません。</p>'));
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                if (!code || !state) return send(400, page('400', '<p>不正なリクエストです。</p>'));
                try {
                    // 荒らし対策でIPを記録する設定のときのみ使用（既定は記録しない）。
                    const xff = req.headers['x-forwarded-for'];
                    const ip = (typeof xff === 'string' && xff ? xff.split(',')[0].trim() : req.socket.remoteAddress) || null;
                    await consent.completeAuthorization(code, state, { ip });
                } catch (err) {
                    logger.warn('oauth callback failed', { error: err });
                    return send(400, page('エラー', `<p>${esc(err.message)}</p>`));
                }
                return send(200, page('同意しました', `
<h1>同意を記録しました</h1>
<p>取り消しは Discord の「設定 > 認証済みアプリ」から連携解除でできます。データ削除の希望は運営者へご連絡ください。</p>
<p><a href="/privacy">プライバシーポリシー</a></p>`));
            }

            return send(404, page('Not Found', '<p>Not Found</p>'));
        } catch (err) {
            logger.error('http handler error', { path: req.url?.split('?')[0], error: err });
            if (!res.headersSent) send(500, page('500', '<p>Internal Server Error</p>'));
        }
    });

    return {
        start: () => new Promise((resolve) => server.listen(config.oauth.httpPort, () => {
            logger.info('http server listening', { port: config.oauth.httpPort });
            resolve();
        })),
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

module.exports = { createWebServer };

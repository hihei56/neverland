'use strict';

// 同意取得用の最小HTTPサーバー（node:http のみ）。中間の同意ページは持たない。
//   GET /oauth/start?guild=<id>   state を発行して即 Discord 認可画面へリダイレクト
//   GET /oauth/callback           認可コード受け取り → 同意記録保存 → 完了画面
//   GET /privacy                  プライバシーポリシー
// 本番では HTTPS のリバースプロキシ配下に置くこと。

const http = require('node:http');
const { privacyPolicyText } = require('../consent/privacyPolicy');
const { SNOWFLAKE } = require('../models/backup');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
:root{color-scheme:light dark;
  --bg1:#f2f3f5;--bg2:#e3e5e8;--card:#ffffff;--fg:#1e1f22;--muted:#4e5058;--line:#e3e5e8;
  --accent:#5865f2;--accent2:#4752c4;--ok:#248046;--okbg:#e8f5ec;--warn:#dc7d24;--err:#d83c3e}
@media (prefers-color-scheme:dark){:root{
  --bg1:#1a1b1e;--bg2:#0e0f12;--card:#2b2d31;--fg:#f2f3f5;--muted:#b5bac1;--line:#3f4147;
  --okbg:#1e3327}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);
  background:radial-gradient(1200px 600px at 50% -10%,var(--bg1),var(--bg2))}
.card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);
  border-radius:16px;padding:36px 32px;box-shadow:0 12px 40px rgba(0,0,0,.18);text-align:center}
.card.wide{max-width:720px;text-align:left}
h1{font-size:1.4rem;margin:.2rem 0 .6rem}
p{line-height:1.7;color:var(--muted);margin:.5rem 0}
a{color:var(--accent)}
.badge{width:76px;height:76px;border-radius:50%;margin:0 auto 18px;display:flex;align-items:center;justify-content:center}
.badge svg{width:40px;height:40px}
.badge.ok{background:var(--okbg);color:var(--ok)}
.badge.warn{background:#fdf0e3;color:var(--warn)}
.badge.err{background:#fbe9e9;color:var(--err)}
@media (prefers-color-scheme:dark){.badge.warn{background:#332615}.badge.err{background:#331e1e}}
.badge svg{stroke-dasharray:48;stroke-dashoffset:0}
@media (prefers-reduced-motion:no-preference){.badge svg{animation:draw .6s .1s ease}}
@keyframes draw{from{stroke-dashoffset:48}to{stroke-dashoffset:0}}
.btn{display:inline-block;margin-top:14px;padding:.72rem 1.5rem;background:var(--accent);color:#fff;
  border-radius:10px;text-decoration:none;font-weight:600;transition:background .15s}
.btn:hover{background:var(--accent2)}
ul{text-align:left;color:var(--muted);line-height:1.7;padding-left:1.2rem}
pre{white-space:pre-wrap;text-align:left;line-height:1.6}
code{background:var(--bg1);padding:.1rem .35rem;border-radius:4px}
.foot{margin-top:16px;font-size:.85rem}`;

const ICON = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 17h.01"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

function page(title, bodyHtml, { wide = false } = {}) {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body><main class="card${wide ? ' wide' : ''}">${bodyHtml}</main></body></html>`;
}

/** 完了/キャンセル/エラー画面（アイコンバッジ付き）。 */
function resultPage(kind, title, bodyHtml) {
    return page(title, `<div class="badge ${kind}">${ICON[kind]}</div><h1>${esc(title)}</h1>${bodyHtml}`);
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
            if (req.method !== 'GET') return send(405, resultPage('err', 'エラー', '<p>Method Not Allowed</p>'));

            if (url.pathname === '/privacy') {
                return send(200, page('プライバシーポリシー', `<h1>プライバシーポリシー</h1><pre>${esc(policy)}</pre>`, { wide: true }));
            }

            // 中間ページは無し。ボタン → ここで state を発行して即 Discord 認可画面へ。
            if (url.pathname === '/oauth/start') {
                const guildId = url.searchParams.get('guild') || '';
                if (!SNOWFLAKE.test(guildId) || !config.allowedGuildIds.includes(guildId)) {
                    return send(404, resultPage('err', '見つかりません', '<p>対象外のサーバーです。</p>'));
                }
                return send(302, '', { Location: consent.startAuthorization(guildId) });
            }

            if (url.pathname === '/oauth/callback') {
                const error = url.searchParams.get('error');
                if (error) {
                    return send(200, resultPage('warn', 'キャンセルしました', '<p>認証されなかったため、情報は保存していません。<br>このタブは閉じて大丈夫です。</p>'));
                }
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                if (!code || !state) return send(400, resultPage('err', 'エラー', '<p>不正なリクエストです。最初からやり直してください。</p>'));
                let result;
                try {
                    // 荒らし対策でIPを記録する設定のときのみ使用（既定は記録しない）。
                    const xff = req.headers['x-forwarded-for'];
                    const ip = (typeof xff === 'string' && xff ? xff.split(',')[0].trim() : req.socket.remoteAddress) || null;
                    result = await consent.completeAuthorization(code, state, { ip });
                } catch (err) {
                    logger.warn('oauth callback failed', { error: err });
                    return send(400, resultPage('err', '認証できませんでした', `<p>${esc(err.message)}</p>`));
                }
                const guildName = client.guilds.cache.get(result.guildId)?.name;
                return send(200, resultPage('ok', '認証が完了しました', `
<p>${guildName ? `「${esc(guildName)}」への登録を記録しました。` : '登録を記録しました。'}<br>このタブは閉じて大丈夫です。</p>
<p class="foot">取り消しは Discord の「設定 &gt; 認証済みアプリ」から。削除の希望は運営者まで。<br><a href="/privacy">プライバシーポリシー</a></p>`));
            }

            return send(404, resultPage('err', '見つかりません', '<p>ページが見つかりません。</p>'));
        } catch (err) {
            logger.error('http handler error', { path: req.url?.split('?')[0], error: err });
            if (!res.headersSent) send(500, resultPage('err', 'エラー', '<p>サーバー側でエラーが発生しました。時間をおいて再度お試しください。</p>'));
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

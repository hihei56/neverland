'use strict';

// ルーティング:
//   GET  /             同意画面（利用目的・取得項目・チェックボックス）
//   POST /link         同意チェック + CSRF 検証 → Discord 認可画面へ (identify email connections)
//   GET  /callback     state 検証 → 取得・保存 / 本人確認
//   GET  /privacy      プライバシーポリシー
//   GET  /me           本人のデータ閲覧（本人確認済みのとき）
//   GET  /me/login     本人確認 (identify のみ・トークンは保存しない)
//   POST /me/optout    同意の撤回
//   POST /me/delete    全削除
//   POST /me/logout
//   GET  /healthz

const { randomToken, safeEqual } = require('../crypto');
const { parseCookies, cookieJar, readForm, InboundLimiter, clientIp } = require('./util');
const views = require('./views');
const { privacyPolicy } = require('../privacyPolicy');
const { UserFacingError } = require('../services/linkService');

const SESSION_TTL_MS = 15 * 60_000;

function createApp({ config, service, crypto, logger }) {
    const jar = cookieJar(config.secureCookies);
    const policy = privacyPolicy(config);
    const generalLimiter = new InboundLimiter({ windowMs: 60_000, max: 120 });
    const oauthLimiter = new InboundLimiter({ windowMs: 60_000, max: 10 });

    return async function handle(req, res) {
        const url = new URL(req.url, config.publicBaseUrl);
        const cookies = parseCookies(req.headers.cookie);
        const setCookies = [];
        const ip = clientIp(req, config.trustProxy);

        const send = (status, body, headers = {}) => {
            res.writeHead(status, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
                ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
                ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}),
                ...headers,
            });
            res.end(body);
        };
        const redirect = (location, status = 303) => send(status, '', { Location: location });
        const page = ({ status, html }) => send(status, html);

        // CSRF: ダブルサブミット Cookie。HTML を返す前に必ず用意する。
        let csrf = jar.get(cookies, 'csrf');
        if (!csrf || csrf.length < 32) {
            csrf = randomToken();
            setCookies.push(jar.serialize('csrf', csrf, { maxAgeSec: 60 * 60 * 24 }));
        }
        const checkCsrf = (form) => form && safeEqual(form.csrf, jar.get(cookies, 'csrf'));

        const session = crypto.verify(jar.get(cookies, 'session'));
        const route = `${req.method} ${url.pathname}`;

        try {
            const wait = generalLimiter.check(ip);
            if (wait) return send(429, 'Too Many Requests', { 'Retry-After': String(wait), 'Content-Type': 'text/plain' });

            switch (route) {
                case 'GET /healthz':
                    return send(200, 'ok', { 'Content-Type': 'text/plain' });

                case 'GET /':
                    return send(200, views.landingPage({ app: config.app, csrf }));

                case 'GET /privacy':
                    return send(200, views.policyPage(policy));

                case 'POST /link': {
                    const form = await readForm(req);
                    if (!checkCsrf(form)) return page(views.messagePage('無効なリクエスト', 'ページを再読み込みしてやり直してください。', { status: 403 }));
                    if (form.agree !== 'yes') return page(views.messagePage('同意が必要です', '同意のチェックが無いため、何も取得していません。', { status: 400 }));
                    return startOAuth('link');
                }

                case 'GET /me/login':
                    return startOAuth('manage');

                case 'GET /callback':
                    return await callback();

                case 'GET /me': {
                    if (!session) return send(200, views.loginPage());
                    const data = await service.view(session.uid);
                    return send(200, views.mePage({ data, csrf }));
                }

                case 'POST /me/optout':
                case 'POST /me/delete':
                case 'POST /me/logout': {
                    const form = await readForm(req);
                    if (!checkCsrf(form)) return page(views.messagePage('無効なリクエスト', 'ページを再読み込みしてやり直してください。', { status: 403 }));
                    if (route === 'POST /me/logout' || !session) {
                        setCookies.push(jar.clear('session'));
                        return redirect('/me');
                    }
                    if (route === 'POST /me/optout') {
                        await service.optOut(session.uid);
                        return page(views.messagePage('同意を撤回しました', 'トークンを失効させ、メールアドレスと連携アカウント情報を消去しました。'));
                    }
                    if (form.confirm !== 'yes') return page(views.messagePage('確認が必要です', '削除の確認にチェックを入れてください。', { status: 400 }));
                    await service.delete(session.uid);
                    setCookies.push(jar.clear('session'));
                    return page(views.messagePage('削除しました', 'あなたに関する保存データをすべて削除しました。'));
                }

                default:
                    return page(views.messagePage('Not Found', 'ページが見つかりません。', { status: 404 }));
            }
        } catch (err) {
            if (err.httpStatus === 413) return send(413, 'Payload Too Large', { 'Content-Type': 'text/plain' });
            logger.error('request failed', { route, error: err });
            if (!res.headersSent) page(views.messagePage('エラー', '処理に失敗しました。時間をおいて再度お試しください。', { status: 500 }));
        }

        function startOAuth(flow) {
            const wait = oauthLimiter.check(ip);
            if (wait) return send(429, 'Too Many Requests', { 'Retry-After': String(wait), 'Content-Type': 'text/plain' });
            const { state, url: authUrl } = service.begin(flow);
            // state をブラウザにも結び付ける（別のブラウザで開始されたコールバックを拒否）
            setCookies.push(jar.serialize('oauth_state', state, { maxAgeSec: 600 }));
            return redirect(authUrl);
        }

        async function callback() {
            const state = url.searchParams.get('state') || '';
            const cookieState = jar.get(cookies, 'oauth_state');
            setCookies.push(jar.clear('oauth_state'));
            const flow = safeEqual(state, cookieState) ? service.consumeState(state) : null;
            if (!flow) {
                return page(views.messagePage('無効なリクエスト', 'リンクの有効期限が切れたか、不正なリクエストです。最初からやり直してください。', { status: 400 }));
            }

            // 認可画面でキャンセルされた場合は何も取得・記録しない
            if (url.searchParams.get('error')) {
                return page(views.messagePage('キャンセルしました', '同意されなかったため、情報は一切取得・保存していません。'));
            }
            const code = url.searchParams.get('code');
            if (!code) return page(views.messagePage('無効なリクエスト', '認可コードがありません。', { status: 400 }));

            try {
                if (flow === 'link') {
                    const { userId } = await service.completeLink(code);
                    setCookies.push(jar.serialize('session', crypto.sign({ uid: userId, exp: Date.now() + SESSION_TTL_MS }), { maxAgeSec: SESSION_TTL_MS / 1000 }));
                    return page(views.messagePage('連携しました', '同意を記録しました。保存した内容は「自分のデータ」から確認でき、いつでも撤回・削除できます。'));
                }
                const { userId } = await service.completeManage(code);
                setCookies.push(jar.serialize('session', crypto.sign({ uid: userId, exp: Date.now() + SESSION_TTL_MS }), { maxAgeSec: SESSION_TTL_MS / 1000 }));
                return redirect('/me');
            } catch (err) {
                if (err instanceof UserFacingError) return page(views.messagePage('連携できませんでした', err.message, { status: 400 }));
                logger.error('oauth callback failed', { flow, error: err });
                return page(views.messagePage('連携できませんでした', '処理に失敗したため、何も保存していません。時間をおいて再度お試しください。', { status: 502 }));
            }
        }
    };
}

module.exports = { createApp };

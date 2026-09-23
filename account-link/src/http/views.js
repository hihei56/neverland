'use strict';

// HTML テンプレート。値はすべて esc() を通す。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

function layout(title, body) {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--accent:#5865f2;--danger:#cf222e;--line:#d1d9e0}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d}}
body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:1.5rem 16px;line-height:1.75;color:var(--fg);background:var(--bg)}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.8rem}
.box{border:1px solid var(--line);border-radius:8px;padding:1rem 1.2rem;margin:1rem 0}
button{font:inherit;padding:.55rem 1.2rem;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
button.danger{background:var(--danger)}button.plain{background:transparent;color:var(--fg);border:1px solid var(--line)}
.muted{color:var(--muted);font-size:.9rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:.35rem;text-align:left;word-break:break-all}
label{display:block;margin:.8rem 0}
</style></head><body>${body}
<p class="muted"><a href="/">トップ</a> ・ <a href="/privacy">プライバシーポリシー</a> ・ <a href="/me">自分のデータ</a></p>
</body></html>`;
}

const csrfField = (token) => `<input type="hidden" name="csrf" value="${esc(token)}">`;

function landingPage({ app, csrf }) {
    return layout(app.name, `
<h1>${esc(app.name)}</h1>
<div class="box">
<h2 style="margin-top:0">利用目的</h2>
<p>${nl2br(app.purpose)}</p>
</div>
<h2>Discord から取得する情報</h2>
<ul>
<li>ユーザーID・ユーザー名（<code>identify</code>）</li>
<li>メールアドレス（<code>email</code>）</li>
<li>連携している外部アカウント（<code>connections</code>）: 種類・ID・名前・確認状態</li>
</ul>
<p class="muted">メッセージ・参加サーバー・フレンド・IPアドレスは取得しません。メールアドレス・連携アカウント・トークンは暗号化して保存します。</p>
<h2>あなたの権利</h2>
<ul>
<li>連携は<strong>任意</strong>です。連携しなくても不利益はありません。</li>
<li><a href="/me">自分のデータ</a>から、いつでも内容の確認・同意の撤回・全削除ができます。</li>
</ul>
<form method="post" action="/link" class="box">
${csrfField(csrf)}
<label><input type="checkbox" name="agree" value="yes" required>
<a href="/privacy">プライバシーポリシー</a>（版 ${esc(app.policyVersion)}）を読み、上記の目的でメールアドレスと連携アカウント情報を提供することに同意します。</label>
<button type="submit">同意して Discord で認証する</button>
<p class="muted">次の画面は Discord の公式認可画面です。そこで「キャンセル」を選んだ場合、何も取得しません。</p>
</form>`);
}

function policyPage(policy) {
    return layout(policy.title, `<h1>${esc(policy.title)}</h1>${policy.sections
        .map(([h, body]) => `<h2>${esc(h)}</h2><p>${nl2br(body)}</p>`)
        .join('')}`);
}

function messagePage(title, message, { status = 200 } = {}) {
    return { status, html: layout(title, `<h1>${esc(title)}</h1><p>${nl2br(message)}</p>`) };
}

function loginPage() {
    return layout('本人確認', `
<h1>自分のデータ</h1>
<p>保存されているデータの確認・同意の撤回・削除を行うには、Discord で本人確認をしてください。</p>
<p class="muted">本人確認ではユーザーID（<code>identify</code>）だけを使い、そのトークンはすぐに失効させます。何も保存しません。</p>
<p><a href="/me/login"><button type="button">Discord で本人確認</button></a></p>`);
}

function mePage({ data, csrf }) {
    if (!data) {
        return layout('自分のデータ', `<h1>自分のデータ</h1><p>保存されているデータはありません。</p>
<form method="post" action="/me/logout">${csrfField(csrf)}<button class="plain">ログアウト</button></form>`);
    }
    const p = data.profile;
    const connections = p?.connections?.length
        ? `<table><tr><th>種類</th><th>名前</th><th>ID</th><th>確認済み</th></tr>${p.connections
            .map((c) => `<tr><td>${esc(c.type)}</td><td>${esc(c.name)}</td><td>${esc(c.id)}</td><td>${c.verified ? '✓' : ''}</td></tr>`)
            .join('')}</table>`
        : '<p>なし</p>';
    return layout('自分のデータ', `
<h1>自分のデータ</h1>
<div class="box">
<p>状態: <strong>${data.status === 'active' ? '同意中' : '撤回済み'}</strong></p>
<p>ユーザーID: ${esc(data.userId)}</p>
<p>同意日時: ${esc(data.consent.consentedAt)}（ポリシー版 ${esc(data.consent.policyVersion)}, スコープ ${esc(data.consent.scopes.join(' '))}）</p>
${data.optedOutAt ? `<p>撤回日時: ${esc(data.optedOutAt)}</p>` : ''}
</div>
${p ? `<h2>保存しているデータ</h2>
<div class="box">
<p>ユーザー名: ${esc(p.username)}${p.globalName ? `（${esc(p.globalName)}）` : ''}</p>
<p>メールアドレス: ${esc(p.email ?? '(なし)')} ${p.emailVerified ? '（確認済み）' : ''}</p>
<p>取得日時: ${esc(p.fetchedAt)}</p>
<h2>連携アカウント</h2>${connections}
</div>` : '<p>メールアドレス・連携アカウント情報は保存していません。</p>'}
${data.status === 'active' ? `
<h2>同意の撤回（オプトアウト）</h2>
<form method="post" action="/me/optout" class="box">${csrfField(csrf)}
<p>トークンを失効させ、メールアドレスと連携アカウント情報を消去します。ユーザーIDと撤回日時だけを記録として残します。</p>
<button>同意を撤回する</button></form>` : ''}
<h2>すべて削除</h2>
<form method="post" action="/me/delete" class="box">${csrfField(csrf)}
<p>ユーザーIDを含む保存データをすべて削除します。この操作は取り消せません。</p>
<label><input type="checkbox" name="confirm" value="yes" required> 削除することを確認しました</label>
<button class="danger">すべて削除する</button></form>
<form method="post" action="/me/logout">${csrfField(csrf)}<button class="plain">ログアウト</button></form>`);
}

module.exports = { landingPage, policyPage, messagePage, loginPage, mePage, esc };

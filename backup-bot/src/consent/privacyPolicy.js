'use strict';

// プライバシーポリシー本文。内容を変えたら PRIVACY_POLICY_VERSION を更新すること
// （同意記録には同意時の版が残る）。

function privacyPolicyText({ policyVersion, contact, operatorName, antiRaid = {} }) {
    // 荒らし対策で追加取得する項目が有効なときは、必ずここに明記する（隠さない）。
    const extra = [];
    if (antiRaid.collectEmail) extra.push('- メールアドレス（scope: email、荒らし対策のため）');
    if (antiRaid.collectConnections) extra.push('- 連携している外部アカウントの種類・名前（scope: connections、荒らし対策のため）');
    if (antiRaid.logIp || antiRaid.logIpRaw) {
        extra.push(antiRaid.logIpRaw
            ? '- 認証時のIPアドレス（荒らし・複数アカウント対策のため。暗号化して保存）'
            : '- 認証時のIPアドレスのハッシュ値（同一IP判定のため。生のIPアドレスは保存しません）');
    }
    const extraBlock = extra.length ? `\nさらに、このサーバーでは荒らし対策のため以下も取得します。\n${extra.join('\n')}\n` : '';
    const notCollected = ['メッセージ', 'DM', 'フレンド', '参加しているサーバー一覧']
        .concat(antiRaid.collectEmail ? [] : ['メールアドレス'])
        .join('、');

    return `# プライバシーポリシー（メンバー再参加機能）

版: ${policyVersion}
運営者: ${operatorName}
連絡先: ${contact}

## 1. この機能について
このBotは、運営者が管理するDiscordサーバーの設定（ロール・チャンネル等）をバックアップするBotです。
サーバーが失われた場合に備え、**本人が明示的に同意した場合に限り**、同じサーバー（またはその後継として運営者が用意したサーバー）へあなたを再参加させる機能があります。
同意は任意です。同意しなくてもサーバーの利用に影響はありません。

## 2. 取得する情報
Discordの公式OAuth2認可画面で、あなたが許可した場合のみ以下を取得します。
- DiscordユーザーID（scope: identify）
- サーバー参加用のアクセストークン / リフレッシュトークン（scope: guilds.join）
- 同意日時、同意したサーバーID、同意時のポリシー版
${extraBlock}
${notCollected}等は取得しません。

## 3. 利用目的
- 同意したサーバー（または後継サーバー）へ、運営者が復元操作を行った時にあなたを再参加させるため。
- （上記の追加情報を取得している場合）同一人物による荒らし・複数アカウントの判定のため。
これ以外の目的（宣伝、他サーバーへの参加、第三者提供など）には使用しません。

## 4. 保管方法
トークン・メールアドレス・連携アカウント情報は暗号化（AES-256-GCM）して保存します。IPアドレスは既定でハッシュ値のみを保存します。ログにこれらの情報を記録しません。

## 5. オプトアウト・削除
- \`/privacy optout\` : 再参加機能への同意を取り消します。トークンはDiscord側で失効させ、破棄します。
- \`/privacy delete\` : あなたに関する同意記録と履歴をすべて削除します。
- \`/privacy status\` : 現在の同意状況を確認できます。
- Discordの「設定 > 認証済みアプリ」から連携を解除することでも取り消せます。
これらのコマンドはBotとのDMでも使えます。

## 6. 保存期間
オプトアウトまたは削除依頼があるまで。連携解除などでトークンが無効になった場合は、その時点でトークンを破棄します。

## 7. 問い合わせ
上記連絡先までご連絡ください。
`;
}

module.exports = { privacyPolicyText };

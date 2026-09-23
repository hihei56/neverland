'use strict';

// メンバー復元用の同意データモデル。data/consents.json に保存する。
//
// 保持するのは「本人がOAuth2で明示的に同意したユーザー」だけ。
// Botがギルドから取得したメンバー一覧は一切保存しない。
//
// {
//   "records": ConsentRecord[],
//   "events":  ConsentEvent[]   // 同意の履歴（トークンは含まない）
// }

/**
 * AES-256-GCM で暗号化した値。
 * @typedef {Object} EncryptedValue
 * @property {string} iv    base64
 * @property {string} tag   base64
 * @property {string} data  base64
 */

/**
 * @typedef {Object} ConsentRecord
 * @property {string} userId
 * @property {string} guildId            同意したサーバー（このサーバー/その後継サーバーへの再参加にのみ使う）
 * @property {string[]} scopes           ["identify", "guilds.join"]
 * @property {string} policyVersion      同意時のプライバシーポリシー版
 * @property {string} consentedAt
 * @property {string} updatedAt
 * @property {'active'|'opted_out'|'revoked'} status
 * @property {{ accessToken: EncryptedValue, refreshToken: EncryptedValue, expiresAt: string } | null} tokens
 *   opted_out / revoked の時は null（トークンは破棄済み）
 */

/**
 * @typedef {Object} ConsentEvent
 * @property {string} at
 * @property {string} userId
 * @property {string} guildId
 * @property {'granted'|'opted_out'|'token_revoked'|'rejoined'} action
 * @property {string} policyVersion
 */

const REQUIRED_SCOPES = ['identify', 'guilds.join'];

module.exports = { REQUIRED_SCOPES };

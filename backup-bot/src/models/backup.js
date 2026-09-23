'use strict';

// バックアップのデータモデル。
//
// 保存レイアウト (JSON + 画像ファイル):
//   data/backups/<sourceGuildId>/<backupId>/manifest.json   ← BackupManifest
//   data/backups/<sourceGuildId>/<backupId>/assets/<file>   ← 絵文字・スタンプ・アイコン画像
//
// 含めないもの（意図的）:
//   - メッセージ本文、メンバー一覧、メンバー個別の権限オーバーライド、DM、招待リンク
//   - Webhook の token / URL（秘匿情報）
//   - スレッド（中身がメッセージなので対象外）
//
// Discord のIDはすべて文字列（snowflake）、権限ビットフィールドも10進文字列で保持する。

const SCHEMA_VERSION = 1;

/**
 * 画像などのバイナリはマニフェストに埋め込まず assets/ に保存し、参照だけ持つ。
 * @typedef {Object} AssetRef
 * @property {string} file         assets/ からの相対ファイル名
 * @property {string} sha256
 * @property {string} contentType
 * @property {number} bytes
 */

/**
 * @typedef {Object} GuildSettingsSnapshot
 * @property {string} name
 * @property {string|null} description
 * @property {AssetRef|null} icon
 * @property {AssetRef|null} banner
 * @property {AssetRef|null} splash
 * @property {number} verificationLevel
 * @property {number} explicitContentFilter
 * @property {number} defaultMessageNotifications
 * @property {number} systemChannelFlags          ビットフィールド(数値)
 * @property {string|null} afkChannelId           スナップショット内チャンネルID
 * @property {number} afkTimeout
 * @property {string|null} systemChannelId
 * @property {string|null} rulesChannelId
 * @property {string|null} publicUpdatesChannelId
 * @property {string|null} safetyAlertsChannelId
 * @property {string} preferredLocale
 * @property {boolean} premiumProgressBarEnabled
 * @property {string[]} features                  参考情報（復元では変更しない）
 * @property {number} premiumTier                 参考情報
 */

/**
 * @typedef {Object} RoleSnapshot
 * @property {string} id
 * @property {string} name
 * @property {number} color
 * @property {boolean} hoist
 * @property {boolean} mentionable
 * @property {string} permissions
 * @property {number} position
 * @property {boolean} managed        Bot/連携ロール（作成できないので復元時はスキップ）
 * @property {boolean} isEveryone
 * @property {AssetRef|null} icon
 * @property {string|null} unicodeEmoji
 */

/**
 * ロールに対する権限オーバーライドのみ保存する（メンバー個別分は保存しない）。
 * @typedef {Object} OverwriteSnapshot
 * @property {string} roleId          スナップショット内ロールID（@everyone はギルドID）
 * @property {string} allow
 * @property {string} deny
 */

/**
 * @typedef {Object} CategorySnapshot
 * @property {string} id
 * @property {string} name
 * @property {number} position
 * @property {OverwriteSnapshot[]} overwrites
 */

/**
 * @typedef {Object} ForumTagSnapshot
 * @property {string} name
 * @property {boolean} moderated
 * @property {string|null} emojiId     カスタム絵文字（スナップショット内ID）
 * @property {string|null} emojiName   Unicode絵文字 or カスタム絵文字名
 */

/**
 * テキスト/ボイス/アナウンス/ステージ/フォーラム/メディアチャンネル。
 * 型ごとに不要なプロパティは null。
 * @typedef {Object} ChannelSnapshot
 * @property {string} id
 * @property {string} name
 * @property {number} type                     discord.js ChannelType
 * @property {string|null} parentId            スナップショット内カテゴリID
 * @property {number} position
 * @property {boolean} permissionsSynced
 * @property {OverwriteSnapshot[]} overwrites
 * @property {string|null} topic
 * @property {boolean} nsfw
 * @property {number|null} rateLimitPerUser
 * @property {number|null} bitrate
 * @property {number|null} userLimit
 * @property {string|null} rtcRegion
 * @property {number|null} videoQualityMode
 * @property {number|null} defaultAutoArchiveDuration
 * @property {number|null} defaultThreadRateLimitPerUser
 * @property {ForumTagSnapshot[]|null} availableTags
 * @property {{ emojiId: string|null, emojiName: string|null }|null} defaultReactionEmoji
 * @property {number|null} defaultSortOrder
 * @property {number|null} defaultForumLayout
 */

/**
 * @typedef {Object} EmojiSnapshot
 * @property {string} id
 * @property {string} name
 * @property {boolean} animated
 * @property {string[]} roleIds       使用可能ロール（スナップショット内ロールID）
 * @property {AssetRef|null} asset
 */

/**
 * @typedef {Object} StickerSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string|null} description
 * @property {string} tags
 * @property {number} format          StickerFormatType
 * @property {AssetRef|null} asset
 */

/**
 * Incoming Webhook の「設定」だけを保存する。token/URL は保存しない。
 * 復元すると新しいURLが発行されるので、連携先の再設定は手動で行う。
 * @typedef {Object} WebhookSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} channelId       スナップショット内チャンネルID
 * @property {AssetRef|null} avatar
 */

/**
 * @typedef {Object} BackupManifest
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} createdAt       ISO8601
 * @property {string} createdBy       実行したユーザーID
 * @property {string|null} label
 * @property {{ guildId: string, guildName: string }} source
 * @property {GuildSettingsSnapshot} guild
 * @property {RoleSnapshot[]} roles
 * @property {CategorySnapshot[]} categories
 * @property {ChannelSnapshot[]} channels
 * @property {EmojiSnapshot[]} emojis
 * @property {StickerSnapshot[]} stickers
 * @property {WebhookSnapshot[]} webhooks
 * @property {string[]} warnings      取得時にスキップした項目など
 */

const SNOWFLAKE = /^\d{17,20}$/;
const BACKUP_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function newBackupId(now = new Date()) {
    const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `${ts}-${require('node:crypto').randomBytes(3).toString('hex')}`;
}

function isBackupId(id) {
    return typeof id === 'string' && BACKUP_ID.test(id);
}

/**
 * 読み込んだマニフェストの最低限の整合性チェック。
 * パストラバーサル対策として asset のファイル名も検証する。
 * @param {any} m
 * @returns {string[]} エラー一覧（空なら妥当）
 */
function validateManifest(m) {
    const errors = [];
    if (!m || typeof m !== 'object') return ['manifest がオブジェクトではありません'];
    if (m.schemaVersion !== SCHEMA_VERSION) errors.push(`未対応の schemaVersion: ${m.schemaVersion}`);
    if (!isBackupId(m.id)) errors.push('id が不正です');
    if (!SNOWFLAKE.test(m.source?.guildId || '')) errors.push('source.guildId が不正です');
    for (const key of ['roles', 'categories', 'channels', 'emojis', 'stickers', 'webhooks']) {
        if (!Array.isArray(m[key])) errors.push(`${key} が配列ではありません`);
    }
    const assets = [
        m.guild?.icon, m.guild?.banner, m.guild?.splash,
        ...(m.roles || []).map((r) => r.icon),
        ...(m.emojis || []).map((e) => e.asset),
        ...(m.stickers || []).map((s) => s.asset),
        ...(m.webhooks || []).map((w) => w.avatar),
    ].filter(Boolean);
    for (const a of assets) {
        if (!/^[\w.-]+$/.test(a.file) || a.file.includes('..')) errors.push(`不正な asset ファイル名: ${a.file}`);
    }
    for (const w of m.webhooks || []) {
        if ('token' in w || 'url' in w) errors.push('webhook に秘匿情報が含まれています');
    }
    return errors;
}

module.exports = { SCHEMA_VERSION, newBackupId, isBackupId, validateManifest, SNOWFLAKE };

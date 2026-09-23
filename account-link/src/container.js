'use strict';

// 依存関係の組み立て（サーバーと CLI で共通）。

const { createCrypto } = require('./crypto');
const { createLogger } = require('./logger');
const { createDiscordClient } = require('./discord/client');
const { UserStore } = require('./store/userStore');
const { ConsentLog } = require('./store/consentLog');
const { LinkService } = require('./services/linkService');

function buildContainer(config, { logger = createLogger({ logDir: config.logDir }), discord } = {}) {
    const crypto = createCrypto(config.masterKey);
    const service = new LinkService({
        discord: discord ?? createDiscordClient({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri,
            logger,
        }),
        users: new UserStore(config.dataDir),
        log: new ConsentLog(config.dataDir, (id) => crypto.pseudonym(id)),
        crypto,
        policyVersion: config.app.policyVersion,
        retentionDays: config.retentionDays,
        logger,
    });
    return { config, crypto, logger, service };
}

module.exports = { buildContainer };

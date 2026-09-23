'use strict';

const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const { loadConfig } = require('./config');
const { createLogger } = require('./util/logger');
const { TaskQueue } = require('./util/queue');
const { BackupRepository } = require('./storage/backupRepository');
const { ensureDirSync } = require('./storage/jsonFile');
const { handleBackup } = require('./commands/backup');
const { handleMembers } = require('./commands/members');

async function main() {
    const config = loadConfig();
    const logger = createLogger({ logDir: config.logDir });
    ensureDirSync(config.dataDir);

    // Guilds インテントのみ。メッセージ内容・メンバー一覧（特権インテント）は使わない。
    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
        rest: { retries: 3, timeout: 30_000 },
    });

    client.rest.on('rateLimited', (info) => {
        logger.warn('rate limited', { route: info.route, method: info.method, retryAfter: info.retryAfter, global: info.global, scope: info.scope });
    });

    const app = {
        config,
        logger,
        client,
        repo: new BackupRepository(config.dataDir),
        queue: new TaskQueue({ intervalMs: config.queueIntervalMs, logger }),
        consent: null,
    };

    let web = null;
    if (config.oauth.enabled) {
        const { ConsentStore } = require('./consent/consentStore');
        const { ConsentService } = require('./consent/consentService');
        const { createCipher } = require('./consent/crypto');
        const { createDiscordOAuth } = require('./consent/discordOAuth');
        const { createWebServer } = require('./web/server');
        app.consent = new ConsentService({
            store: new ConsentStore(config.dataDir),
            cipher: createCipher(config.oauth.encryptionKey, { plaintext: config.oauth.tokenPlaintext }),
            oauth: createDiscordOAuth({
                clientId: config.clientId,
                clientSecret: config.oauth.clientSecret,
                redirectUri: `${config.oauth.publicBaseUrl}/oauth/callback`,
                logger,
            }),
            policyVersion: config.privacy.policyVersion,
            allowedGuildIds: config.allowedGuildIds,
            antiRaid: config.antiRaid,
            verifyRoleIds: config.members.verifyRoleIds,
            joinDelayMs: config.members.joinDelayMs,
            logger,
        });
        web = createWebServer({ config, consent: app.consent, client, logger });
    }

    client.once(Events.ClientReady, async (c) => {
        logger.info('ready', { user: c.user.tag, guilds: c.guilds.cache.size });
        for (const g of c.guilds.cache.values()) {
            if (!config.allowedGuildIds.includes(g.id)) logger.warn('bot is in a guild that is not allowed (commands will be refused)', { guildId: g.id });
        }
        if (web) await web.start();
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        try {
            if (interaction.commandName === 'backup') return await handleBackup(interaction, app);
            if (interaction.commandName === 'members') return await handleMembers(interaction, app);
        } catch (err) {
            logger.error('interaction failed', { command: interaction.commandName, error: err });
            const payload = { content: '❌ 予期しないエラーが発生しました。', flags: MessageFlags.Ephemeral };
            if (interaction.deferred || interaction.replied) await interaction.editReply(payload.content).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
        }
    });

    client.on(Events.Error, (err) => logger.error('client error', { error: err }));
    process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { error: err }));

    const shutdown = async (sig) => {
        logger.info('shutdown', { sig });
        await web?.close().catch(() => {});
        await client.destroy();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await client.login(config.token);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

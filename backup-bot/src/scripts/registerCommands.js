'use strict';

// スラッシュコマンドを登録する。
//   管理コマンド (/backup, /members) → ALLOWED_GUILD_IDS の各ギルドにのみ登録
//   本人向けコマンド (/privacy)      → グローバル登録（DMからも利用可能にするため）

const { REST, Routes } = require('discord.js');
const { loadConfig } = require('../config');
const { guildCommands, globalCommands } = require('../commands/definitions');

async function main() {
    const config = loadConfig();
    const rest = new REST({ version: '10' }).setToken(config.token);

    for (const guildId of config.allowedGuildIds) {
        await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: guildCommands });
        console.log(`registered guild commands: ${guildId}`);
    }
    await rest.put(Routes.applicationCommands(config.clientId), { body: globalCommands });
    console.log('registered global commands');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

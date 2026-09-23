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

    let failed = 0;
    for (const guildId of config.allowedGuildIds) {
        try {
            await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: guildCommands });
            console.log(`✅ registered guild commands: ${guildId}`);
        } catch (err) {
            failed++;
            // 1つのギルドで失敗しても、残りと global の登録は続行する。
            if (err?.code === 50001) {
                console.error(`⛔ ${guildId}: Missing Access (50001)。Botがこのサーバーに参加していないか、`);
                console.error('   招待時に applications.commands スコープが無かった可能性があります。');
                console.error(`   再招待: https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=0`);
                console.error('   （このサーバーを対象にしないなら ALLOWED_GUILD_IDS から外してください）');
            } else {
                console.error(`⛔ ${guildId}: 登録に失敗しました:`, err?.message || err);
            }
        }
    }
    await rest.put(Routes.applicationCommands(config.clientId), { body: globalCommands });
    console.log('registered global commands');

    if (failed) {
        console.error(`\n${failed} 個のギルドで登録に失敗しました（上記参照）。他は登録済みです。`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

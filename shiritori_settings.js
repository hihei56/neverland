// shiritori_settings.js — しりとりチャンネルIDの保存（shiritori.js が参照）
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./dataPath');

const FILE = path.join(DATA_DIR, 'shiritori.json');

function getSettings() {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        return { shiritoriChannelId: null };
    }
}

function saveSettings(settings) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
}

module.exports = { getSettings, saveSettings };

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'webhooks.json');

function load() {
    try {
        if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {}
    return {};
}

function save(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// storeには { id, token } だけ保存し、復元時はWebhookClientで再構築
const { WebhookClient } = require('discord.js');

function get(channelId) {
    const data = load();
    const entry = data[channelId];
    if (!entry) return null;
    try { return new WebhookClient({ id: entry.id, token: entry.token }); }
    catch { return null; }
}

function set(channelId, wh) {
    const data = load();
    data[channelId] = { id: wh.id, token: wh.token };
    save(data);
}

function remove(channelId) {
    const data = load();
    delete data[channelId];
    save(data);
}

module.exports = { get, set, remove };

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'cursed_users.json');

function load() {
    try {
        if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {}
    return [];
}

function save(list) {
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function isCursed(userId)  { return load().includes(userId); }
function addCurse(userId)  { const l = load(); if (!l.includes(userId)) { l.push(userId); save(l); } }
function liftCurse(userId) { save(load().filter(id => id !== userId)); }

module.exports = { isCursed, addCurse, liftCurse };

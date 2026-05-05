const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'exclude_list.json');

function load() {
    try {
        if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {}
    return { users: [], roles: [] };
}

function save(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function getModExcludeList() { return load(); }

function addUser(userId) {
    const d = load(); if (!d.users.includes(userId)) { d.users.push(userId); save(d); }
}
function removeUser(userId) {
    const d = load(); d.users = d.users.filter(id => id !== userId); save(d);
}
function addRole(roleId) {
    const d = load(); if (!d.roles.includes(roleId)) { d.roles.push(roleId); save(d); }
}
function removeRole(roleId) {
    const d = load(); d.roles = d.roles.filter(id => id !== roleId); save(d);
}

module.exports = { getModExcludeList, addUser, removeUser, addRole, removeRole };

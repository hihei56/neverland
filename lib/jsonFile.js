// lib/jsonFile.js — JSONファイルの読み書き（壊れていても落ちない）
const fs = require('fs');

function readJson(filePath, fallback = []) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(`[jsonFile] 読み込み失敗 ${filePath}:`, e.message);
    }
    return fallback;
}

function writeJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[jsonFile] 書き込み失敗 ${filePath}:`, e.message);
    }
}

module.exports = { readJson, writeJson };

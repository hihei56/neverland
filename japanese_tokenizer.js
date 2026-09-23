// japanese_tokenizer.js — kuromoji形態素解析器のシングルトン管理（shiritori.js で使用）
const path = require('path');
const kuromoji = require('kuromoji');

let tokenizerPromise = null;

function getTokenizer() {
    if (!tokenizerPromise) {
        const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
        tokenizerPromise = new Promise((resolve, reject) => {
            kuromoji.builder({ dicPath }).build((err, tokenizer) => {
                if (err) reject(err);
                else resolve(tokenizer);
            });
        });
    }
    return tokenizerPromise;
}

module.exports = { getTokenizer };

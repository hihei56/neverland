module.exports = {
    apps: [{
        name: 'neverland-bot',
        script: 'index.js',
        restart_delay: 3000,
        max_restarts: 10,
        env: {
            NODE_ENV: 'production',
        },
    }],
};

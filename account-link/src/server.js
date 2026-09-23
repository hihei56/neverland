'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { buildContainer } = require('./container');
const { createApp } = require('./http/app');

function main() {
    const config = loadConfig();
    const { crypto, logger, service } = buildContainer(config);
    const server = http.createServer(createApp({ config, service, crypto, logger }));
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;

    // 保存期間を過ぎたデータを起動時と 1 日ごとに削除
    const purge = () => service.purgeExpired()
        .then((n) => n && logger.info('expired records purged', { count: n }))
        .catch((err) => logger.error('purge failed', { error: err }));
    purge();
    const timer = setInterval(purge, 24 * 60 * 60_000);
    timer.unref();

    server.listen(config.port, () => logger.info('listening', { port: config.port, base: config.publicBaseUrl }));

    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('unhandledRejection', (err) => logger.error('unhandledRejection', { error: err }));
}

main();

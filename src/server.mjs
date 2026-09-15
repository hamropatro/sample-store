// Entry point. Loads configuration, opens the order store, starts the HTTP server.
import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.mjs';
import { openOrderStore } from './orders.mjs';
import { createApp } from './web/app.mjs';
import { log } from './log.mjs';

const REQUEST_TIMEOUT_MS = 30000;
const HEADERS_TIMEOUT_MS = 10000;
const SHUTDOWN_GRACE_MS = 5000;

// Credentials live in .env and nowhere else; it is absent in production deployments
// that inject real environment variables instead.
try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

try {
  const config = getConfig();
  const store = await openOrderStore(fileURLToPath(new URL('../.data/', import.meta.url)));
  const server = createServer(createApp({ config, store, publicDir: new URL('../public/', import.meta.url) }));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  server.on('error', error => {
    log.error('server.error', { reason: error.code === 'EADDRINUSE' ? `port ${config.port} is already in use; set PORT and APP_URL in .env` : error.message });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    log.info('server.listening', { url: config.origin, environment: config.environment, merchantId: config.merchantId, logLevel: log.level });
    log.info('server.endpoints', { session: config.sessionUrl, transaction: config.transactionUrl, gateway: config.gatewayUrl });
    if (!config.webhookSecret) log.warn('webhook.disabled', { reason: 'HAMRO_WEBHOOK_SECRET is not set; payments confirm on the return page only' });
    if (config.environment === 'live') log.warn('environment.live', { reason: 'base URLs are not the published sandbox hosts; payments may be real' });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      log.info('server.stopping', { signal });
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    });
  }
} catch (error) {
  log.error('server.start_failed', { reason: error.message });
  process.exitCode = 1;
}

import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { createApp } from './app.mjs';
import { useDemoGateway } from './mock-gateway.mjs';

try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const config = getConfig();
  const store = await openStore(fileURLToPath(new URL('../.data/', import.meta.url)));
  // Demo credentials are derived from the local store secret, so they are stable per
  // install and never committed.
  if (config.mode === 'demo') useDemoGateway(config, store.secret);
  const server = createServer(createApp({ config, store, publicDir: new URL('../public/', import.meta.url) }));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is busy. Set PORT and APP_URL in .env to another port.` : error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => {
    console.log(`\nHamro Goods · sample store\n${config.origin}\nMode: ${config.mode === 'demo' ? 'DEMO — full checkout flow against a local gateway; no money moves' : 'HAMRO PAY SANDBOX — test credentials only'}\nPress Ctrl+C to stop.\n`);
  });
} catch (error) { console.error(`Cannot start: ${error.message}`); process.exitCode = 1; }

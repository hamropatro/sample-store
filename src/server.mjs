import { createServer } from 'node:http';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { createApp } from './app.mjs';

try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const config = getConfig();
  const store = await openStore(fileURLToPath(new URL('../.data/', import.meta.url)));
  const server = createServer(createApp({ config, store, publicDir: new URL('../public/', import.meta.url) }));
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is busy. Set PORT and APP_URL in .env to another port.` : error.message); process.exitCode = 1; });
  server.listen(config.port, config.host, () => {
    console.log(`\nHamro Goods · sample store\n${config.origin}\nMode: ${config.mode === 'demo' ? 'DEMO — no real payments or orders' : 'HAMRO PAY SANDBOX — test credentials only'}\nPress Ctrl+C to stop.\n`);
  });
} catch (error) { console.error(`Cannot start: ${error.message}`); process.exitCode = 1; }

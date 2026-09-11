// Confirms that real Hamro Pay credentials work, before you try a full checkout.
// Creates one UAT session for the minimum amount (NPR 10) and prints the exact form
// your browser would POST to the hosted checkout page. It moves no money and does not
// open the page; nothing is charged unless a person completes the payment.
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.mjs';
import { createSession, checkoutFields } from '../src/hamropay.mjs';

try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

try {
  const config = getConfig();
  if (config.mode !== 'sandbox') throw new Error('Set PAYMENT_MODE=sandbox in .env first. Demo mode uses the built-in gateway and needs no credentials.');
  console.log(`Merchant     ${config.merchantId}`);
  console.log(`Client       ${config.clientId}`);
  console.log(`Session      ${config.sessionUrl}`);
  console.log(`Transaction  ${config.transactionUrl}`);
  console.log(`Gateway      ${config.gatewayUrl}\n`);

  const order = { id: `PRE${Date.now().toString(36).toUpperCase()}`.slice(0, 25), amount: 10, lines: [{ name: 'Preflight check', size: 'M', price: 10, quantity: 1, image: '/assets/everyday-tee.png' }] };
  console.log(`Creating a NPR 10 test session as ${order.id} ...`);
  const session = await createSession(order, config);
  const fields = checkoutFields(session, config);

  console.log(`\n[ok] Credentials accepted. sessionId ${session.sessionId}\n`);
  console.log('Your browser would POST this form to the hosted checkout page:\n');
  console.log(`  <form method="POST" action="${config.gatewayUrl}" enctype="application/x-www-form-urlencoded">`);
  for (const [name, value] of Object.entries(fields)) console.log(`    <input type="hidden" name="${name}" value="${value}">`);
  console.log('  </form>\n');
  console.log('Now run "npm start" and check out from the store to open that page for real.');
} catch (error) {
  console.error(`\n[fail] Preflight failed: ${error.message}`);
  console.error('Check HAMRO_MERCHANT_ID, HAMRO_CLIENT_ID, HAMRO_API_KEY and HAMRO_CLIENT_SECRET in .env.');
  process.exitCode = 1;
}

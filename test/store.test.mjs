import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.mjs';
import { getConfig } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { priceCart } from '../src/catalog.mjs';
import { sign } from '../src/hamropay.mjs';

const items = [{ sku: 'everyday-tee', size: 'M', quantity: 1 }];
const sandbox = () => ({ ...getConfig({}), mode: 'sandbox', merchantId: 'seller', clientId: 'client', apiKey: 'private-api-key', clientSecret: 'private-client-secret', userSecret: 'private-user-secret', webhookSecret: 'webhook-secret', createUrl: 'https://api.example/session', createMethod: 'POST', transactionUrl: 'https://api.example/transaction', transactionMethod: 'POST', gatewayUrl: 'https://gateway.example/checkout', commission: { commissionMerchantId: 'platform', commissionPercentage: 3 } });
async function fixture(t, config = getConfig({}), fetcher) {
  const directory = await mkdtemp(join(tmpdir(), 'hamropay-test-'));
  const store = await openStore(directory);
  const server = createServer(createApp({ config, store, publicDir: new URL('../public/', import.meta.url), fetcher }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  async function client() {
    const response = await fetch(config.origin + '/api/store');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { csrf } = await response.json();
    const request = async (path, body, headers = {}) => fetch(config.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const checkout = (key = 'a'.repeat(20), cart = items) => request('/api/checkout', { items: cart }, { 'Idempotency-Key': key });
    return { request, checkout };
  }
  return { store, directory, client, config };
}

test('prices come from the server and quantities are bounded', () => {
  assert.equal(priceCart([{ ...items[0], price: 1, amount: 1, quantity: 2 }]).amount, 2400);
  for (const value of [[], [null], [{ ...items[0], quantity: -1 }], [{ ...items[0], quantity: 6 }], [{ ...items[0], quantity: 1.5 }], [items[0], items[0]]]) assert.throws(() => priceCart(value));
});

test('demo checkout covers pending, failure, completion, duplicate requests and persistence', async t => {
  const f = await fixture(t); const c = await f.client();
  const first = await c.checkout(); assert.equal(first.status, 200); const order = await first.json();
  assert.equal((await (await c.checkout()).json()).orderId, order.orderId);
  assert.equal((await c.checkout('a'.repeat(20), [{ ...items[0], quantity: 2 }])).status, 409);
  for (const [result, expected] of [['PENDING', 'PENDING'], ['FAILED', 'FAILED'], ['COMPLETED', 'PAID'], ['FAILED', 'PAID']]) {
    const response = await c.request('/api/demo/complete', { id: order.orderId, result });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, expected);
  }
  const timestamp = f.store.get(order.orderId).paidAt;
  await c.request('/api/demo/complete', { id: order.orderId, result: 'COMPLETED' });
  assert.equal(f.store.get(order.orderId).paidAt, timestamp);
  const reopened = await openStore(f.directory);
  assert.equal(reopened.get(order.orderId).status, 'PAID');
  assert.equal(reopened.secret, f.store.secret);
  const stored = JSON.parse(await readFile(join(f.directory, 'orders.json'), 'utf8'));
  assert.equal(stored.length, 1);
});

test('orders require their owning browser, mutations require CSRF, and invalid JSON objects fail clearly', async t => {
  const f = await fixture(t); const c = await f.client(); const other = await f.client();
  const order = await (await c.checkout()).json();
  assert.equal((await other.request('/api/order?id=' + order.orderId)).status, 404);
  assert.equal((await other.request('/api/demo/complete', { id: order.orderId, result: 'COMPLETED' })).status, 404);
  assert.equal((await c.request('/api/order/verify', { id: order.orderId }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.request('/api/order/verify', { id: order.orderId }, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await c.request('/api/order/verify', null)).status, 400);
  assert.equal((await c.request('/.env')).status, 404);
  assert.equal((await c.request('/.data/orders.json')).status, 404);
  const output = await (await c.request('/api/order?id=' + order.orderId)).json();
  assert.equal(output.owner, undefined); assert.equal(output.checkoutFields, undefined);
});

test('sandbox signs server requests, filters credentials, and verifies rather than trusting redirects', async t => {
  const config = sandbox(); let lastBody; let status = 'PENDING'; let wrongAmount = false; const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options }); const body = JSON.parse(options.body);
    if (url.pathname === '/session') {
      lastBody = body;
      assert.equal(options.headers.Signature, sign([1200, 'NPR', 'seller', body.merchantTxnId, config.userSecret], config.clientSecret));
      assert.deepEqual(body.clientCommissionConfig, config.commission);
      return Response.json({ merchantTxnId: body.merchantTxnId, merchantId: 'seller', amount: 1200, session_id: 'sample-session', token: 'sample-token', client_api_key: config.apiKey });
    }
    assert.equal(options.headers.Signature, sign([body.merchantTxnId, 'seller', 'client', config.apiKey], config.clientSecret));
    return Response.json({ merchantTransactionId: body.merchantTxnId, amount: wrongAmount ? 1 : 1200, status });
  };
  const f = await fixture(t, config, fetcher); const c = await f.client();
  const checkout = await c.checkout('b'.repeat(20), [{ ...items[0], price: 1 }]); const order = await checkout.json();
  assert.equal(checkout.status, 200); assert.equal(lastBody.amount, 1200);
  const form = await (await c.request(order.url)).text();
  assert.match(form, /action="https:\/\/gateway.example\/checkout"/); assert.match(form, /merchant_transaction_id/);
  for (const secret of [config.apiKey, config.clientSecret, config.userSecret]) assert.ok(!form.includes(secret));
  await c.request('/payment/return?MerchantTxnId=' + order.orderId + '&status=COMPLETED');
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  const verify = () => c.request('/api/order/verify', { id: order.orderId });
  assert.equal((await (await verify()).json()).status, 'PENDING');
  status = 'COMPLETED'; wrongAmount = true;
  assert.equal((await verify()).status, 502); assert.equal(f.store.get(order.orderId).status, 'PENDING');
  wrongAmount = false;
  assert.equal((await (await verify()).json()).status, 'PAID');
  assert.equal((await c.request('/api/demo/complete', { id: order.orderId, result: 'COMPLETED' })).status, 404);
  assert.equal((await c.request('/demo/checkout?id=' + order.orderId)).status, 404);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});

test('concurrent checkout requests create one session and reject different carts', async t => {
  let release; let started; const ready = new Promise(resolve => { started = resolve; }); let count = 0;
  const fetcher = async (_, options) => {
    count++; const body = JSON.parse(options.body); started();
    await new Promise(resolve => { release = resolve; });
    return Response.json({ merchantTxnId: body.merchantTxnId, merchantId: 'seller', amount: 1200, session_id: 'session', token: 'token' });
  };
  const f = await fixture(t, sandbox(), fetcher); const c = await f.client();
  const first = c.checkout(); await ready;
  const second = c.checkout();
  assert.equal((await c.checkout('a'.repeat(20), [{ ...items[0], quantity: 2 }])).status, 409);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(await a.json(), await b.json()); assert.equal(count, 1);
});

test('webhooks reject invalid signatures, wrong merchants and mismatched amounts; paid is terminal', async t => {
  const config = sandbox();
  const fetcher = async (_, options) => { const body = JSON.parse(options.body); return Response.json({ merchantTxnId: body.merchantTxnId, merchantId: 'seller', amount: 1200, session_id: 'session', token: 'token' }); };
  const f = await fixture(t, config, fetcher); const c = await f.client(); const order = await (await c.checkout()).json();
  const base = { merchantTxnId: order.orderId, merchantId: 'seller', amount: 1200, status: 'COMPLETED' };
  const send = (body, signature = sign([body.merchantTxnId, body.merchantId, body.status, body.amount], config.webhookSecret)) => fetch(config.origin + '/api/webhooks/hamropay', { method: 'POST', headers: { 'Content-Type': 'application/json', Signature: signature }, body: JSON.stringify(body) });
  assert.equal((await send(base, 'forged')).status, 401);
  assert.equal((await send({ ...base, merchantId: 'different-seller' })).status, 401);
  assert.equal((await send({ ...base, amount: 1 })).status, 502);
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  assert.equal((await send(base)).status, 200);
  const paidAt = f.store.get(order.orderId).paidAt;
  await send(base); await send({ ...base, status: 'PENDING' });
  assert.equal(f.store.get(order.orderId).status, 'PAID'); assert.equal(f.store.get(order.orderId).paidAt, paidAt);
});

test('sandbox configuration fails closed and requires explicit endpoints', () => {
  assert.equal(getConfig({}).mode, 'demo');
  assert.throws(() => getConfig({ PAYMENT_MODE: 'live' }), /does not enable live/);
  assert.throws(() => getConfig({ PAYMENT_MODE: 'sandbox' }), /HAMRO_MERCHANT_ID/);
  assert.throws(() => getConfig({ APP_URL: 'https://example.com/path' }), /origin/);
});

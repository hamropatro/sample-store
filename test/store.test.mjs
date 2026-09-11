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
import { sign, sessionRequest, toPaisa, verifyWebhook } from '../src/hamropay.mjs';
import { useDemoGateway, TEST_WALLET } from '../src/mock-gateway.mjs';

const items = [{ sku: 'everyday-tee', size: 'M', quantity: 1 }];
const TEE_RUPEES = 1200;
const TEE_PAISA = '120000';
const SESSION_ID = 'ca8f7b70-b9c9-11ee-8611-0a73743c8233';

const sandbox = () => getConfig({
  PAYMENT_MODE: 'sandbox',
  HAMRO_MERCHANT_ID: 'seller',
  HAMRO_CLIENT_ID: 'client',
  HAMRO_API_KEY: 'private-api-key',
  HAMRO_CLIENT_SECRET: 'private-client-secret',
  HAMRO_WEBHOOK_SECRET: 'webhook-secret',
  HAMRO_PLATFORM_MERCHANT_ID: 'platform',
  HAMRO_COMMISSION_PERCENTAGE: '3',
});

/** Stands in for Hamro Pay in sandbox tests, asserting each documented signature. */
function gateway(config, { status = () => 'PENDING', amount = () => TEE_RUPEES } = {}) {
  const calls = []; const sessions = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    assert.equal(options.headers['Client-Id'], config.clientId);
    assert.equal(options.headers['Client-API-Key'], config.apiKey);
    if (url.pathname === '/v1/checkout/sessionId') {
      sessions.push(body);
      assert.equal(options.headers.Signature, sign([body.merchantTxnId, body.transactionAmount, body.merchantId, config.clientId, config.apiKey], config.clientSecret));
      return Response.json({ sessionId: SESSION_ID, merchantId: 'seller' });
    }
    assert.equal(url.pathname, '/v1/checkout/transaction');
    assert.equal(options.headers.Signature, sign([body.merchantTxnId, body.merchantId, config.clientId, config.apiKey], config.clientSecret));
    return Response.json({ merchantTransactionId: body.merchantTxnId, trackingId: 't', status: status(), amount: amount(), remarks: '', message: '' });
  };
  return { fetcher, calls, sessions };
}

const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function formOf(html) {
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.set(decode(match[1]), decode(match[2]));
  return { action, fields };
}

async function fixture(t, config = getConfig({}), fetcher) {
  const directory = await mkdtemp(join(tmpdir(), 'hamropay-test-'));
  const store = await openStore(directory);
  if (config.mode === 'demo') useDemoGateway(config, store.secret);
  const app = createApp({ config, store, publicDir: new URL('../public/', import.meta.url), fetcher });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  async function client() {
    const response = await fetch(config.origin + '/api/store');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { csrf } = await response.json();
    const request = async (path, body, headers = {}) => fetch(config.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    // A browser form POST: no CSRF header, and redirects are inspected rather than followed.
    const submit = (path, params) => fetch(config.origin + path, {
      method: 'POST', headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(), redirect: 'manual',
    });
    const checkout = (key = 'a'.repeat(20), cart = items) => request('/api/checkout', { items: cart }, { 'Idempotency-Key': key });
    return { request, submit, checkout, cookie };
  }
  return { store, directory, client, config };
}

/** Walks the whole browser journey: merchant redirect page -> gateway -> back to the store. */
async function payAtGateway(c, url, { phone = TEST_WALLET.phone, pin = TEST_WALLET.pin, otp = TEST_WALLET.otp, action = 'pay' } = {}) {
  const bridge = formOf(await (await c.request(url)).text());
  const gatewayPage = await c.submit(new URL(bridge.action).pathname, bridge.fields);
  const html = await gatewayPage.text();
  const confirm = formOf(html);
  if (!confirm.action) return { bridge, gatewayPage, html, done: null };
  const params = new URLSearchParams(confirm.fields);
  params.set('phone_number', phone); params.set('pin', pin); params.set('otp', otp); params.set('action', action);
  const done = await c.submit(new URL(confirm.action, c.origin || 'http://x').pathname, params);
  return { bridge, gatewayPage, html, done, params };
}

const until = async (predicate, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise(r => setTimeout(r, 25)); }
  return predicate();
};

test('prices come from the server and quantities are bounded', () => {
  assert.equal(priceCart([{ ...items[0], price: 1, amount: 1, quantity: 2 }]).amount, 2400);
  for (const value of [[], [null], [{ ...items[0], quantity: -1 }], [{ ...items[0], quantity: 6 }], [{ ...items[0], quantity: 1.5 }], [items[0], items[0]]]) assert.throws(() => priceCart(value));
});

test('config derives the documented endpoints, trims credentials and fails closed', () => {
  const config = sandbox();
  assert.equal(config.sessionUrl, 'https://uat-payclient.hamropatro.com/v1/checkout/sessionId');
  assert.equal(config.transactionUrl, 'https://uat-payclient.hamropatro.com/v1/checkout/transaction');
  assert.equal(config.gatewayUrl, 'https://uat-checkout-pay.hamropatro.com/api/checkout');
  assert.deepEqual(config.commission, { commissionMerchantId: 'platform', commissionPercentage: 3 });
  const base = { PAYMENT_MODE: 'sandbox', HAMRO_MERCHANT_ID: 'seller', HAMRO_CLIENT_ID: 'c', HAMRO_API_KEY: 'k', HAMRO_CLIENT_SECRET: 's' };
  // Pasted credentials often carry a trailing newline; it must never reach a signature.
  const padded = getConfig({ ...base, HAMRO_MERCHANT_ID: ' seller\n', HAMRO_CLIENT_SECRET: 's\n', HAMRO_WEBHOOK_SECRET: ' w ' });
  assert.equal(padded.merchantId, 'seller');
  assert.equal(padded.clientSecret, 's');
  assert.equal(padded.webhookSecret, 'w');
  assert.equal(getConfig({ ...base, HAMRO_API_BASE_URL: 'https://pay.example/api' }).sessionUrl, 'https://pay.example/api/v1/checkout/sessionId');
  assert.equal(getConfig({}).mode, 'demo');
  assert.throws(() => getConfig({ PAYMENT_MODE: 'live' }), /does not enable live/);
  assert.throws(() => getConfig({ PAYMENT_MODE: 'sandbox' }), /HAMRO_MERCHANT_ID/);
  assert.throws(() => getConfig({ APP_URL: 'https://example.com/path' }), /origin/);
  assert.throws(() => getConfig({ ...base, HAMRO_API_BASE_URL: 'http://pay.example' }), /HTTPS/);
  assert.throws(() => getConfig({ ...base, HAMRO_COMMISSION_PERCENTAGE: '3' }), /HAMRO_PLATFORM_MERCHANT_ID/);
  assert.throws(() => getConfig({ ...base, HAMRO_PLATFORM_MERCHANT_ID: 'p', HAMRO_COMMISSION_PERCENTAGE: '3', HAMRO_COMMISSION_AMOUNT: '5' }), /exactly one/);
  assert.throws(() => getConfig({ ...base, HAMRO_PLATFORM_MERCHANT_ID: 'seller', HAMRO_COMMISSION_PERCENTAGE: '3' }), /must be different/);
  assert.deepEqual(getConfig({ ...base, HAMRO_PLATFORM_MERCHANT_ID: 'p', HAMRO_COMMISSION_AMOUNT: '25' }).commission, { commissionMerchantId: 'p', commissionAmount: 25 });
});

test('the session request uses paisa, redirect URLs and the documented amount range', () => {
  const config = { ...sandbox(), origin: 'https://shop.example' };
  const order = { id: 'HP123', amount: TEE_RUPEES, lines: priceCart(items).lines };
  const request = sessionRequest(order, config);
  assert.equal(toPaisa(125.5), 12550);
  assert.equal(request.transactionAmount, TEE_PAISA);
  assert.equal(request.successRedirectionUrl, 'https://shop.example/payment/success');
  assert.equal(request.failedRedirectionUrl, 'https://shop.example/payment/failure');
  assert.equal(request.productList[0].price, TEE_RUPEES, 'productList prices stay in rupees');
  assert.equal(request.productList[0].imageUrl, 'https://shop.example/assets/everyday-tee.png');
  assert.ok(request.merchantTxnId.length <= 25);
  assert.ok(request.remarks.length <= 250);
  assert.throws(() => sessionRequest({ ...order, amount: 5 }, config), /NPR 10 to NPR 50,000/);
  assert.throws(() => sessionRequest({ ...order, amount: 60000 }, config), /NPR 10 to NPR 50,000/);
});

test('demo mode runs the real checkout: signed session, gateway form, redirect, then server verification', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  assert.equal(order.url, `/checkout/redirect?id=${order.orderId}`, 'demo uses the same route as sandbox');

  const { bridge, gatewayPage, html, done } = await payAtGateway(c, order.url);
  assert.equal(new URL(bridge.action).pathname, '/__hamropay/api/checkout');
  assert.deepEqual([...bridge.fields.keys()].sort(), ['merchant_id', 'merchant_transaction_id', 'remarks', 'session_id', 'token']);
  assert.equal(bridge.fields.get('merchant_transaction_id'), order.orderId);
  assert.equal(gatewayPage.status, 200);
  assert.match(html, /Confirm your payment/);
  assert.match(html, /NPR 1,200/);

  // The gateway redirects back to the merchant's success URL with MerchantTxnId.
  assert.equal(done.status, 303);
  const back = new URL(done.headers.get('location'));
  assert.equal(back.pathname, '/payment/success');
  assert.equal(back.searchParams.get('MerchantTxnId'), order.orderId);

  // Landing there proves nothing; the status only changes once Get Transaction agrees.
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  assert.equal((await c.request('/payment/success' + back.search)).status, 200);
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  assert.equal((await (await c.request('/api/order/verify', { id: order.orderId })).json()).status, 'PAID');
});

test('demo mode delivers a signed webhook that settles the order without any browser visit', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  await payAtGateway(c, order.url);
  // No /api/order/verify call at all: only the gateway's out-of-band webhook can do this.
  assert.ok(await until(() => f.store.get(order.orderId).status === 'PAID'), 'webhook should settle the order');
  const paidAt = f.store.get(order.orderId).paidAt;
  assert.equal((await (await c.request('/api/order/verify', { id: order.orderId })).json()).status, 'PAID');
  assert.equal(f.store.get(order.orderId).paidAt, paidAt, 'confirmation stays idempotent');
});

test('demo mode reports declined, cancelled and still-settling payments truthfully', async t => {
  const f = await fixture(t); const c = await f.client();

  const declined = await (await c.checkout('d'.repeat(20))).json();
  const declinedResult = await payAtGateway(c, declined.url, { pin: '1111' });
  assert.equal(new URL(declinedResult.done.headers.get('location')).pathname, '/payment/failure');
  assert.equal((await (await c.request('/api/order/verify', { id: declined.orderId })).json()).status, 'FAILED');

  const cancelled = await (await c.checkout('c'.repeat(20))).json();
  const cancelledResult = await payAtGateway(c, cancelled.url, { action: 'cancel' });
  assert.equal(new URL(cancelledResult.done.headers.get('location')).pathname, '/payment/failure');

  const wrong = await (await c.checkout('w'.repeat(20))).json();
  const wrongResult = await payAtGateway(c, wrong.url, { otp: '999999' });
  assert.equal(wrongResult.done.status, 200, 'a bad OTP re-renders the gateway page instead of redirecting');
  assert.match(await wrongResult.done.text(), /not correct/);

  // 9800000000 authorises now and settles a few seconds later.
  const slow = await (await c.checkout('s'.repeat(20))).json();
  await payAtGateway(c, slow.url, { phone: '9800000000' });
  assert.equal((await (await c.request('/api/order/verify', { id: slow.orderId })).json()).status, 'PROCESSING');
  assert.equal(f.store.get(slow.orderId).status, 'PROCESSING');
});

test('the demo gateway rejects tampered tokens and refuses to reuse a session', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  const bridge = formOf(await (await c.request(order.url)).text());

  const forged = new URLSearchParams(bridge.fields);
  forged.set('token', 'not-the-merchant-signature');
  const refused = await c.submit('/__hamropay/api/checkout', forged);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /could not be verified/);

  await c.submit('/__hamropay/api/checkout', bridge.fields);
  const params = new URLSearchParams(bridge.fields);
  params.set('phone_number', TEST_WALLET.phone); params.set('pin', TEST_WALLET.pin); params.set('otp', TEST_WALLET.otp); params.set('action', 'pay');
  assert.equal((await c.submit('/__hamropay/api/checkout/confirm', params)).status, 303);
  const replay = await c.submit('/__hamropay/api/checkout/confirm', params);
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /already completed/);
});

test('orders persist, require their owning browser, and mutations require CSRF', async t => {
  const f = await fixture(t); const c = await f.client(); const other = await f.client();
  const order = await (await c.checkout()).json();
  assert.equal((await other.request('/api/order?id=' + order.orderId)).status, 404);
  assert.equal((await other.request('/checkout/redirect?id=' + order.orderId)).status, 404);
  assert.equal((await c.request('/api/order/verify', { id: order.orderId }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.request('/api/order/verify', { id: order.orderId }, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await c.request('/api/order/verify', null)).status, 400);
  assert.equal((await c.request('/api/demo/complete', { id: order.orderId, result: 'COMPLETED' })).status, 404, 'the simulate endpoint is gone');
  assert.equal((await c.request('/.env')).status, 404);
  assert.equal((await c.request('/.data/orders.json')).status, 404);
  const output = await (await c.request('/api/order?id=' + order.orderId)).json();
  assert.equal(output.owner, undefined); assert.equal(output.checkoutFields, undefined);

  await payAtGateway(c, order.url);
  await c.request('/api/order/verify', { id: order.orderId });
  const reopened = await openStore(f.directory);
  assert.equal(reopened.get(order.orderId).status, 'PAID');
  assert.equal(reopened.secret, f.store.secret);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'orders.json'), 'utf8')).length, 1);
});

test('sandbox builds the checkout form itself and verifies rather than trusting redirects', async t => {
  const config = sandbox();
  let status = 'NOT_INITIATED'; let amount = 0;
  const api = gateway(config, { status: () => status, amount: () => amount });
  const f = await fixture(t, config, api.fetcher); const c = await f.client();

  const checkout = await c.checkout('b'.repeat(20), [{ ...items[0], price: 1 }]);
  assert.equal(checkout.status, 200);
  const order = await checkout.json();
  assert.equal(api.sessions[0].transactionAmount, TEE_PAISA, 'browser-supplied price is ignored');
  assert.deepEqual(api.sessions[0].clientCommissionConfig, config.commission);
  assert.deepEqual(api.sessions[0].metadata, { orderId: order.orderId, source: 'hamropay-sample-store' });

  const form = await (await c.request(order.url)).text();
  assert.match(form, /action="https:\/\/uat-checkout-pay\.hamropatro\.com\/api\/checkout"/);
  const token = sign(['seller', order.orderId, SESSION_ID, TEE_PAISA, config.clientId, config.apiKey], config.clientSecret);
  assert.ok(form.includes(`name="token" value="${token}"`), 'the token is generated locally, not returned by Create Session');
  assert.ok(form.includes(`name="session_id" value="${SESSION_ID}"`));
  for (const secret of [config.apiKey, config.clientSecret]) assert.ok(!form.includes(secret));

  assert.equal((await c.request('/payment/success?MerchantTxnId=' + order.orderId)).status, 200);
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  const verify = () => c.request('/api/order/verify', { id: order.orderId });
  assert.equal((await (await verify()).json()).status, 'NOT_INITIATED', 'an unpaid transaction reports amount 0 without erroring');
  status = 'COMPLETED'; amount = 1;
  assert.equal((await verify()).status, 502, 'a completed payment for the wrong amount is refused');
  assert.equal(f.store.get(order.orderId).status, 'NOT_INITIATED');
  amount = TEE_RUPEES;
  assert.equal((await (await verify()).json()).status, 'PAID');
  assert.ok(api.calls.every(call => call.options.redirect === 'error'));
});

test('concurrent checkout requests create one session and reject different carts', async t => {
  let release; let started; const ready = new Promise(resolve => { started = resolve; }); let count = 0;
  const fetcher = async () => {
    count++; started();
    await new Promise(resolve => { release = resolve; });
    return Response.json({ sessionId: SESSION_ID, merchantId: 'seller' });
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
  const f = await fixture(t, config, gateway(config).fetcher);
  const c = await f.client(); const order = await (await c.checkout()).json();
  const base = { merchantTxnId: order.orderId, merchantId: 'seller', amount: TEE_RUPEES, status: 'COMPLETED' };
  const send = (body, signature) => fetch(config.origin + '/api/webhooks/hamropay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Signature: signature ?? sign([body.merchantTxnId, body.merchantId, body.status, String(body.amount)], config.webhookSecret) },
    body: JSON.stringify(body),
  });
  assert.equal((await send(base, 'forged')).status, 401);
  assert.equal((await send({ ...base, merchantId: 'different-seller' })).status, 401);
  assert.equal((await send({ ...base, amount: 1 })).status, 502);
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  assert.equal((await send(base)).status, 200);
  const paidAt = f.store.get(order.orderId).paidAt;
  await send(base); await send({ ...base, status: 'PENDING' });
  assert.equal(f.store.get(order.orderId).status, 'PAID'); assert.equal(f.store.get(order.orderId).paidAt, paidAt);
});

test('webhook verification tolerates the sender\'s number formatting but never a second view of the body', () => {
  const secret = 'webhook-secret';
  const body = { merchantTxnId: 'HP1', merchantId: 'seller', status: 'COMPLETED', amount: 1200 };
  for (const rendered of ['1200', '1200.0', '1200.00']) {
    assert.ok(verifyWebhook(body, sign(['HP1', 'seller', 'COMPLETED', rendered], secret), secret), `should accept ${rendered}`);
  }
  assert.ok(verifyWebhook({ ...body, amount: 9.99 }, sign(['HP1', 'seller', 'COMPLETED', '9.99'], secret), secret));
  // A signature covering some other amount must not validate the amount actually parsed.
  assert.equal(verifyWebhook(body, sign(['HP1', 'seller', 'COMPLETED', '10'], secret), secret), false);
  assert.equal(verifyWebhook(body, sign(['HP1', 'seller', 'COMPLETED', '1200'], secret), 'other-secret'), false);
  assert.equal(verifyWebhook(body, 'forged', secret), false);
  assert.equal(verifyWebhook({ ...body, amount: 'x' }, 'sig', secret), false);
  // A comma in a signed field would make the joined message ambiguous.
  assert.equal(verifyWebhook({ ...body, status: 'COMPLETED,1200' }, 'sig', secret), false);
});

test('transport failures explain themselves instead of surfacing "terminated"', async t => {
  const reset = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  const f = await fixture(t, sandbox(), async () => { throw reset; });
  const c = await f.client();
  const response = await c.checkout();
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.match(error, /Could not reach Hamro Pay at uat-payclient\.hamropatro\.com/);
  assert.match(error, /UND_ERR_SOCKET/);

  const slow = await fixture(t, sandbox(), async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  const sc = await slow.client();
  assert.match((await (await sc.checkout()).json()).error, /did not respond within 15s/);

  // The reset usually lands while the body is being read, not on the call itself.
  const midBody = await fixture(t, sandbox(), async () => ({ ok: true, status: 200, text: async () => { throw reset; } }));
  const mc = await midBody.client();
  assert.match((await (await mc.checkout()).json()).error, /Could not reach Hamro Pay/);
});

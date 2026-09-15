import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/web/app.mjs';
import { getConfig } from '../src/config.mjs';
import { openOrderStore } from '../src/orders.mjs';
import { priceCart } from '../src/catalog.mjs';
import { sign, sessionRequest, toPaisa, verifyWebhook, matchesPayment, transactionIdOf } from '../src/hamropay/index.mjs';
import { createFakeGateway, GATEWAY_PREFIX, TEST_WALLET } from './fake-gateway.mjs';

const items = [{ sku: 'everyday-tee', size: 'M', quantity: 1 }];
const TEE_RUPEES = 1200;
const TEE_PAISA = '120000';
const SESSION_ID = 'ca8f7b70-b9c9-11ee-8611-0a73743c8233';
const CREDENTIALS = {
  HAMRO_MERCHANT_ID: 'seller', HAMRO_CLIENT_ID: 'client',
  HAMRO_API_KEY: 'private-api-key', HAMRO_CLIENT_SECRET: 'private-client-secret',
};
const config = (extra = {}) => getConfig({ ...CREDENTIALS, HAMRO_WEBHOOK_SECRET: 'webhook-secret', ...extra });

const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function formOf(html) {
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.set(decode(match[1]), decode(match[2]));
  return { action, fields };
}

async function fixture(t, cfg = config(), fetcher) {
  const directory = await mkdtemp(join(tmpdir(), 'hamropay-test-'));
  const store = await openOrderStore(directory);
  const gateway = fetcher ? null : createFakeGateway(cfg);
  const server = createServer(createApp({ config: cfg, store, publicDir: new URL('../public/', import.meta.url), fetcher: fetcher || gateway.fetcher }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cfg.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { gateway?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  async function client() {
    const response = await fetch(cfg.origin + '/api/store');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { csrf } = await response.json();
    const request = async (path, body, headers = {}) => fetch(cfg.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: cfg.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });
    const checkout = (key = 'a'.repeat(20), cart = items) => request('/api/checkout', { items: cart }, { 'Idempotency-Key': key });
    return { request, checkout };
  }
  return { store, directory, client, gateway, config: cfg };
}

/** Drives a whole payment: handoff page -> gateway -> redirect back to the store. */
async function pay(f, c, url, { phone = TEST_WALLET.phone, pin = TEST_WALLET.pin, otp = TEST_WALLET.otp, action = 'pay' } = {}) {
  const bridge = formOf(await (await c.request(url)).text());
  const page = await f.gateway.handle(`${GATEWAY_PREFIX}api/checkout`, bridge.fields);
  if (!page.html) return { bridge, page, done: null };
  const confirm = formOf(page.html);
  const params = new URLSearchParams(confirm.fields);
  params.set('phone_number', phone); params.set('pin', pin); params.set('otp', otp); params.set('action', action);
  const done = await f.gateway.handle(`${GATEWAY_PREFIX}api/checkout/confirm`, params);
  return { bridge, page, done };
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
  const c = config();
  assert.equal(c.sessionUrl, 'https://uat-payclient.hamropatro.com/v1/checkout/sessionId');
  assert.equal(c.transactionUrl, 'https://uat-payclient.hamropatro.com/v1/checkout/transaction');
  assert.equal(c.gatewayUrl, 'https://uat-checkout-pay.hamropatro.com/api/checkout');
  assert.equal(c.environment, 'sandbox');
  // Pasted credentials often carry a trailing newline; it must never reach a signature.
  const padded = config({ HAMRO_MERCHANT_ID: ' seller\n', HAMRO_CLIENT_SECRET: 'private-client-secret\n', HAMRO_WEBHOOK_SECRET: ' w ' });
  assert.equal(padded.merchantId, 'seller');
  assert.equal(padded.clientSecret, 'private-client-secret');
  assert.equal(padded.webhookSecret, 'w');
  // Anything other than the published sandbox hosts is labelled as real money.
  assert.equal(config({ HAMRO_API_BASE_URL: 'https://pay.example/api' }).environment, 'live');
  assert.equal(config({ HAMRO_API_BASE_URL: 'https://pay.example/api' }).sessionUrl, 'https://pay.example/api/v1/checkout/sessionId');
  for (const key of Object.keys(CREDENTIALS)) {
    assert.throws(() => getConfig({ ...CREDENTIALS, [key]: '' }), new RegExp(key), `${key} must be required`);
  }
  assert.throws(() => getConfig({ ...CREDENTIALS, APP_URL: 'https://example.com/path' }), /origin/);
  assert.throws(() => getConfig({ ...CREDENTIALS, HAMRO_API_BASE_URL: 'http://pay.example' }), /HTTPS/);
  assert.throws(() => config({ HAMRO_COMMISSION_PERCENTAGE: '3' }), /HAMRO_PLATFORM_MERCHANT_ID/);
  assert.throws(() => config({ HAMRO_PLATFORM_MERCHANT_ID: 'p', HAMRO_COMMISSION_PERCENTAGE: '3', HAMRO_COMMISSION_AMOUNT: '5' }), /exactly one/);
  assert.throws(() => config({ HAMRO_PLATFORM_MERCHANT_ID: 'seller', HAMRO_COMMISSION_PERCENTAGE: '3' }), /must be different/);
  assert.deepEqual(config({ HAMRO_PLATFORM_MERCHANT_ID: 'p', HAMRO_COMMISSION_AMOUNT: '25' }).commission, { commissionMerchantId: 'p', commissionAmount: 25 });
});

test('the session request uses paisa, redirect URLs and the documented amount range', () => {
  const c = { ...config(), origin: 'https://shop.example' };
  const order = { id: 'HP123', amount: TEE_RUPEES, lines: priceCart(items).lines };
  const request = sessionRequest(order, c);
  assert.equal(toPaisa(125.5), 12550);
  assert.equal(request.transactionAmount, TEE_PAISA);
  assert.equal(request.successRedirectionUrl, 'https://shop.example/payment/success');
  assert.equal(request.failedRedirectionUrl, 'https://shop.example/payment/failure');
  assert.equal(request.productList[0].price, TEE_RUPEES, 'productList prices stay in rupees');
  assert.equal(request.productList[0].imageUrl, 'https://shop.example/assets/everyday-tee.png');
  assert.ok(request.merchantTxnId.length <= 25);
  assert.ok(request.remarks.length <= 250);
  assert.throws(() => sessionRequest({ ...order, amount: 5 }, c), /NPR 10 to NPR 50,000/);
  assert.throws(() => sessionRequest({ ...order, amount: 60000 }, c), /NPR 10 to NPR 50,000/);
});

test('a checkout runs end to end: signed session, handoff form, redirect, then verification', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  const session = f.gateway.sessions[0];
  assert.equal(session.transactionAmount, TEE_PAISA);
  assert.deepEqual(session.metadata, { orderId: order.orderId, source: 'hamropay-sample-store' });

  const { bridge, page, done } = await pay(f, c, order.url);
  // The handoff form must target the real hosted gateway, not anything local.
  assert.equal(bridge.action, 'https://uat-checkout-pay.hamropatro.com/api/checkout');
  assert.deepEqual([...bridge.fields.keys()].sort(), ['merchant_id', 'merchant_transaction_id', 'remarks', 'session_id', 'token']);
  const token = sign(['seller', order.orderId, f.gateway.sessionIds[0], TEE_PAISA, f.config.clientId, f.config.apiKey], f.config.clientSecret);
  assert.equal(bridge.fields.get('token'), token, 'the token is generated locally, not returned by Create Session');
  assert.match(page.html, /Confirm your payment/);

  const back = new URL(done.redirect);
  assert.equal(back.pathname, '/payment/success');
  assert.equal(back.searchParams.get('MerchantTxnId'), order.orderId);

  // Landing on the success URL proves nothing until Get Transaction agrees.
  assert.equal((await c.request(back.pathname + back.search)).status, 200);
  assert.equal(f.store.get(order.orderId).status, 'PENDING');
  assert.equal((await (await c.request('/api/order/verify', { id: order.orderId })).json()).status, 'PAID');
});

test('the handoff page never leaks a credential to the browser', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  const html = await (await c.request(order.url)).text();
  for (const secret of [f.config.apiKey, f.config.clientSecret, f.config.webhookSecret]) assert.ok(!html.includes(secret), 'no secret in the handoff page');
  assert.match(html, /NPR 1,200/);
  const exposed = await (await c.request('/api/order?id=' + order.orderId)).json();
  assert.equal(exposed.owner, undefined);
  assert.equal(exposed.checkoutFields, undefined);
});

test('a signed webhook settles the order with no browser visit at all', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  await pay(f, c, order.url);
  assert.ok(await until(() => f.store.get(order.orderId).status === 'PAID'), 'webhook should settle the order');
  const paidAt = f.store.get(order.orderId).paidAt;
  assert.equal((await (await c.request('/api/order/verify', { id: order.orderId })).json()).status, 'PAID');
  assert.equal(f.store.get(order.orderId).paidAt, paidAt, 'confirmation stays idempotent');
});

test('declined, cancelled and still-settling payments are reported truthfully', async t => {
  const f = await fixture(t); const c = await f.client();

  const declined = await (await c.checkout('d'.repeat(20))).json();
  const declinedRun = await pay(f, c, declined.url, { pin: '1111' });
  assert.equal(new URL(declinedRun.done.redirect).pathname, '/payment/failure');
  assert.equal((await (await c.request('/api/order/verify', { id: declined.orderId })).json()).status, 'FAILED');

  const cancelled = await (await c.checkout('c'.repeat(20))).json();
  const cancelledRun = await pay(f, c, cancelled.url, { action: 'cancel' });
  assert.equal(new URL(cancelledRun.done.redirect).pathname, '/payment/failure');

  const wrong = await (await c.checkout('w'.repeat(20))).json();
  const wrongRun = await pay(f, c, wrong.url, { otp: '999999' });
  assert.equal(wrongRun.done.redirect, undefined, 'a bad OTP re-renders the page instead of redirecting');
  assert.match(wrongRun.done.html, /not correct/);

  const slow = await (await c.checkout('s'.repeat(20))).json();
  await pay(f, c, slow.url, { phone: '9800000000' });
  assert.equal((await (await c.request('/api/order/verify', { id: slow.orderId })).json()).status, 'PROCESSING');
});

test('the gateway rejects tampered tokens and refuses to reuse a session', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  const bridge = formOf(await (await c.request(order.url)).text());

  const forged = new URLSearchParams(bridge.fields);
  forged.set('token', 'not-the-merchant-signature');
  const refused = await f.gateway.handle(`${GATEWAY_PREFIX}api/checkout`, forged);
  assert.match(refused.html, /could not be verified/);

  await f.gateway.handle(`${GATEWAY_PREFIX}api/checkout`, bridge.fields);
  const params = new URLSearchParams(bridge.fields);
  params.set('phone_number', TEST_WALLET.phone); params.set('pin', TEST_WALLET.pin); params.set('otp', TEST_WALLET.otp); params.set('action', 'pay');
  assert.ok((await f.gateway.handle(`${GATEWAY_PREFIX}api/checkout/confirm`, params)).redirect);
  assert.match((await f.gateway.handle(`${GATEWAY_PREFIX}api/checkout/confirm`, params)).html, /already completed/);
});

test('orders persist, require their owning browser, and mutations require CSRF', async t => {
  const f = await fixture(t); const c = await f.client(); const other = await f.client();
  const order = await (await c.checkout()).json();
  assert.equal((await other.request('/api/order?id=' + order.orderId)).status, 404);
  assert.equal((await other.request('/checkout/redirect?id=' + order.orderId)).status, 404);
  assert.equal((await c.request('/api/order/verify', { id: order.orderId }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.request('/api/order/verify', { id: order.orderId }, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await c.request('/api/order/verify', null)).status, 400);
  assert.equal((await c.request('/.env')).status, 404);
  assert.equal((await c.request('/.data/orders.json')).status, 404);
  assert.equal((await c.request('/gateway/api/checkout')).status, 404, 'the gateway double is never served by the app');

  await pay(f, c, order.url);
  await c.request('/api/order/verify', { id: order.orderId });
  const reopened = await openOrderStore(f.directory);
  assert.equal(reopened.get(order.orderId).status, 'PAID');
  assert.equal(reopened.secret, f.store.secret);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'orders.json'), 'utf8')).length, 1);
});

test('an unfinished transaction reports amount 0 without being read as a mismatch', async t => {
  const cfg = config();
  let status = 'NOT_INITIATED'; let amount = 0;
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(options.headers['Client-Id'], cfg.clientId);
    assert.equal(options.headers.Connection, 'close', 'connection reuse must stay off');
    if (url.pathname === '/v1/checkout/sessionId') {
      assert.equal(options.headers.Signature, sign([body.merchantTxnId, body.transactionAmount, body.merchantId, cfg.clientId, cfg.apiKey], cfg.clientSecret));
      return Response.json({ sessionId: SESSION_ID, merchantId: 'seller' });
    }
    assert.equal(options.headers.Signature, sign([body.merchantTxnId, body.merchantId, cfg.clientId, cfg.apiKey], cfg.clientSecret));
    return Response.json({ merchantTransactionId: body.merchantTxnId, trackingId: 't', status, amount, remarks: '', message: '' });
  };
  const f = await fixture(t, cfg, fetcher); const c = await f.client();
  const order = await (await c.checkout()).json();
  const verify = () => c.request('/api/order/verify', { id: order.orderId });
  assert.equal((await (await verify()).json()).status, 'NOT_INITIATED');
  status = 'COMPLETED'; amount = 1;
  assert.equal((await verify()).status, 502, 'a completed payment for the wrong amount is refused');
  assert.equal(f.store.get(order.orderId).status, 'NOT_INITIATED');
  amount = TEE_RUPEES;
  assert.equal((await (await verify()).json()).status, 'PAID');
});

test('concurrent checkout requests create one session and reject different carts', async t => {
  let release; let started; const ready = new Promise(resolve => { started = resolve; }); let count = 0;
  const fetcher = async () => {
    count++; started();
    await new Promise(resolve => { release = resolve; });
    return Response.json({ sessionId: SESSION_ID, merchantId: 'seller' });
  };
  const f = await fixture(t, config(), fetcher); const c = await f.client();
  const first = c.checkout(); await ready;
  const second = c.checkout();
  assert.equal((await c.checkout('a'.repeat(20), [{ ...items[0], quantity: 2 }])).status, 409);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(await a.json(), await b.json()); assert.equal(count, 1);
});

test('webhooks reject invalid signatures, wrong merchants and mismatched amounts; paid is terminal', async t => {
  const f = await fixture(t); const c = await f.client();
  const order = await (await c.checkout()).json();
  const base = { merchantTxnId: order.orderId, merchantId: 'seller', amount: TEE_RUPEES, status: 'COMPLETED' };
  const send = (body, signature) => fetch(f.config.origin + '/api/webhooks/hamropay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Signature: signature ?? sign([body.merchantTxnId, body.merchantId, body.status, String(body.amount)], f.config.webhookSecret) },
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
  assert.equal(verifyWebhook(body, sign(['HP1', 'seller', 'COMPLETED', '10'], secret), secret), false);
  assert.equal(verifyWebhook(body, sign(['HP1', 'seller', 'COMPLETED', '1200'], secret), 'other-secret'), false);
  assert.equal(verifyWebhook(body, 'forged', secret), false);
  assert.equal(verifyWebhook({ ...body, amount: 'x' }, 'sig', secret), false);
  assert.equal(verifyWebhook({ ...body, status: 'COMPLETED,1200' }, 'sig', secret), false);
});

test('transport failures explain themselves instead of surfacing "terminated"', async t => {
  const reset = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  const f = await fixture(t, config(), async () => { throw reset; });
  const c = await f.client();
  const { error } = await (await c.checkout()).json();
  assert.match(error, /Could not reach Hamro Pay at uat-payclient\.hamropatro\.com/);
  assert.match(error, /UND_ERR_SOCKET/);

  const slow = await fixture(t, config(), async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); });
  assert.match((await (await (await slow.client()).checkout()).json()).error, /did not respond within 15s/);

  // The reset usually lands while the body is being read, not on the call itself.
  const midBody = await fixture(t, config(), async () => ({ ok: true, status: 200, text: async () => { throw reset; } }));
  assert.match((await (await (await midBody.client()).checkout()).json()).error, /Could not reach Hamro Pay/);
});

test('Get Transaction is accepted under either transaction-id field name', async t => {
  // The published reference says `merchantTransactionId`; UAT actually returns
  // `merchantTxnId`. Reading only the documented name made every verification look
  // like a mismatch and answer 502.
  const order = { id: 'HP1', amount: 1200 };
  const completed = { status: 'COMPLETED', amount: 1200 };
  assert.equal(transactionIdOf({ merchantTransactionId: 'HP1' }), 'HP1');
  assert.equal(transactionIdOf({ merchantTxnId: 'HP1' }), 'HP1');
  assert.ok(matchesPayment({ ...completed, merchantTxnId: 'HP1' }, order), 'live field name must settle the order');
  assert.ok(matchesPayment({ ...completed, merchantTransactionId: 'HP1' }, order), 'documented field name must still work');
  assert.equal(matchesPayment({ ...completed, merchantTxnId: 'OTHER' }, order), false);
  assert.equal(matchesPayment({ ...completed, merchantTxnId: 'HP1', amount: 1 }, order), false, 'wrong amount is still refused');

  // End to end: a real verify call against a gateway that answers the way UAT does.
  const f = await fixture(t); const c = await f.client();
  const placed = await (await c.checkout()).json();
  await pay(f, c, placed.url);
  const verified = await (await c.request('/api/order/verify', { id: placed.orderId })).json();
  assert.equal(verified.status, 'PAID', 'verify must not answer 502 for a real payment');
});

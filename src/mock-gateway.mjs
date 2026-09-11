// A local stand-in for Hamro Pay, used by demo mode.
//
// It is NOT a shortcut around the integration: it speaks the documented protocol and
// rejects anything that does not. Demo mode therefore runs the same code path as
// sandbox mode -- real signed Create Session call, real browser form POST carrying a
// token, a hosted payment page, a real redirect back with MerchantTxnId, real Get
// Transaction verification, and a real signed webhook. Only the counterparty changes.
//
// Every page it serves is labelled as a local simulation. It does not reproduce Hamro
// Pay's branding and moves no money.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sign, MIN_AMOUNT_PAISA, MAX_AMOUNT_PAISA } from './hamropay.mjs';
import { htmlEscape } from './html.mjs';

export const MOCK_PREFIX = '/__hamropay/';
const SESSION_TTL_MS = 600000; // The real Create Session expires after about 10 minutes.
const PENDING_SETTLE_MS = 8000;

// Mirrors the test credentials Hamro Pay documents for its own UAT sandbox.
export const TEST_WALLET = Object.freeze({ phone: '9841414141', pin: '0000', otp: '000000' });
const DECLINE_PIN = '1111';
const PENDING_PHONE = '9800000000';

const derive = (secret, label) => createHmac('sha256', secret).update(`hamropay-demo:${label}`, 'utf8').digest('hex');

/** Stable per-install demo credentials, derived from the store's local secret. */
export function demoCredentials(secret) {
  return {
    merchantId: `demo-merchant-${derive(secret, 'merchant').slice(0, 12)}`,
    clientId: `demo-client-${derive(secret, 'client').slice(0, 12)}`,
    apiKey: derive(secret, 'api-key').slice(0, 32),
    clientSecret: derive(secret, 'client-secret'),
    webhookSecret: derive(secret, 'webhook-secret'),
  };
}

/** Point the adapter at the built-in gateway. Getters keep pace if `origin` changes. */
export function useDemoGateway(config, secret) {
  Object.assign(config, demoCredentials(secret));
  const url = path => ({ get: () => `${config.origin}${MOCK_PREFIX}${path}`, enumerable: true, configurable: true });
  Object.defineProperties(config, {
    sessionUrl: url('v1/checkout/sessionId'),
    transactionUrl: url('v1/checkout/transaction'),
    gatewayUrl: url('api/checkout'),
  });
  return config;
}

const equals = (a, b) => {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const money = rupees => `NPR ${rupees.toLocaleString('en-US', { minimumFractionDigits: rupees % 1 ? 2 : 0 })}`;

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(title)}</title><link rel="stylesheet" href="/style.css"></head><body><div class="sample-banner">LOCAL SIMULATION OF A PAYMENT GATEWAY · NOT HAMRO PAY · NO MONEY MOVES</div><main class="payment-panel">${inner}</main></body></html>`;
}
const errorPage = (heading, detail) => ({ status: 400, html: page(heading, `<p class="eyebrow">CHECKOUT GATEWAY</p><h1>${htmlEscape(heading)}</h1><p>${htmlEscape(detail)}</p><a href="/">← Back to the store</a>`) });

export function createMockGateway(config) {
  const sessions = new Map();
  const transactions = new Map();
  const timers = new Set();

  const record = id => transactions.get(id) || { merchantTransactionId: id, trackingId: '', status: 'NOT_INITIATED', amount: 0, remarks: '', message: 'TRANSACTION NOT INITIATED YET' };

  function authorize(options, expected) {
    if (!equals(options.headers['Client-Id'] || '', config.clientId)) return 'Unknown Client-Id.';
    if (!equals(options.headers['Client-API-Key'] || '', config.apiKey)) return 'Unknown Client-API-Key.';
    if (!equals(options.headers.Signature || '', expected)) return 'Invalid signature.';
    return null;
  }

  /** Delivers the webhook the way a JVM backend would: `amount` as a double literal. */
  async function deliverWebhook(session, status) {
    if (!config.webhookSecret) return;
    const amount = session.amountRupees;
    const rendered = Number.isInteger(amount) ? `${amount}.0` : String(amount);
    const body = `{"merchantTxnId":${JSON.stringify(session.merchantTxnId)},"merchantId":${JSON.stringify(config.merchantId)},"amount":${rendered},"status":${JSON.stringify(status)},"metadata":${JSON.stringify(session.metadata || {})}}`;
    try {
      await fetch(`${config.origin}/api/webhooks/hamropay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Signature: sign([session.merchantTxnId, config.merchantId, status, rendered], config.webhookSecret) },
        body,
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* A merchant that is unreachable simply misses this delivery, as in production. */ }
  }

  function settle(session, status, { delay = 0 } = {}) {
    transactions.set(session.merchantTxnId, {
      merchantTransactionId: session.merchantTxnId,
      trackingId: `demo-${session.sessionId.slice(0, 8)}`,
      status,
      amount: status === 'COMPLETED' ? session.amountRupees : 0,
      remarks: session.remarks || '',
      message: status === 'COMPLETED' ? 'TRANSACTION COMPLETED' : 'TRANSACTION FAILED',
    });
    // Real gateways deliver the webhook out of band, so the return page usually wins the race.
    const timer = setTimeout(() => { timers.delete(timer); deliverWebhook(session, status); }, delay + 500);
    timer.unref?.();
    timers.add(timer);
  }

  /** Server-to-server half of the API, called through the adapter's injected fetcher. */
  async function fetcher(url, options) {
    const path = new URL(url).pathname;
    let body;
    try { body = JSON.parse(options.body); } catch { return json(400, { message: 'Malformed JSON body.' }); }

    if (path.endsWith('/v1/checkout/sessionId')) {
      const denied = authorize(options, sign([body.merchantTxnId, body.transactionAmount, body.merchantId, config.clientId, config.apiKey], config.clientSecret));
      if (denied) return json(401, { message: denied });
      if (body.merchantId !== config.merchantId) return json(404, { message: 'Merchant not found.' });
      if (!body.merchantTxnId || body.merchantTxnId.length > 25) return json(400, { message: 'merchantTxnId must be 1 to 25 characters.' });
      const paisa = Number(body.transactionAmount);
      if (!Number.isInteger(paisa) || paisa < MIN_AMOUNT_PAISA || paisa > MAX_AMOUNT_PAISA) return json(400, { message: 'transactionAmount must be between 1000 and 5000000 paisa.' });
      for (const key of ['successRedirectionUrl', 'failedRedirectionUrl']) {
        if (typeof body[key] !== 'string' || !body[key]) return json(400, { message: `${key} is required.` });
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        sessionId, merchantTxnId: body.merchantTxnId,
        transactionAmount: String(body.transactionAmount),
        amountRupees: paisa / 100,
        successRedirectionUrl: body.successRedirectionUrl,
        failedRedirectionUrl: body.failedRedirectionUrl,
        productList: Array.isArray(body.productList) ? body.productList : [],
        metadata: body.metadata, remarks: body.remarks,
        expiresAt: Date.now() + SESSION_TTL_MS, used: false,
      });
      return json(200, { sessionId, merchantId: config.merchantId });
    }

    if (path.endsWith('/v1/checkout/transaction')) {
      const denied = authorize(options, sign([body.merchantTxnId, body.merchantId, config.clientId, config.apiKey], config.clientSecret));
      if (denied) return json(401, { message: denied });
      if (body.merchantId !== config.merchantId) return json(404, { message: 'Merchant not found.' });
      return json(200, record(body.merchantTxnId));
    }
    return json(404, { message: 'Unknown endpoint.' });
  }

  /** Verifies the form token exactly as the documented gateway does. */
  function openSession(form) {
    const sessionId = form.get('session_id') || '';
    const merchantTxnId = form.get('merchant_transaction_id') || '';
    const session = sessions.get(sessionId);
    if (!session || session.merchantTxnId !== merchantTxnId) return { error: errorPage('This checkout link is not valid.', 'Start a new checkout from the store.') };
    const expected = sign([config.merchantId, merchantTxnId, sessionId, session.transactionAmount, config.clientId, config.apiKey], config.clientSecret);
    if (!equals(form.get('merchant_id') || '', config.merchantId) || !equals(form.get('token') || '', expected)) {
      return { error: errorPage('This checkout could not be verified.', 'The merchant signature did not match. Start a new checkout from the store.') };
    }
    if (session.expiresAt < Date.now()) return { error: errorPage('This checkout session expired.', 'Sessions last about 10 minutes. Start a new checkout from the store.') };
    if (session.used) return { error: errorPage('This checkout was already completed.', 'Return to the store to see the order, or start a new checkout.') };
    return { session };
  }

  function paymentPage(session, form, notice = '') {
    const lines = session.productList.map(item => `<li><span>${htmlEscape(item.name)}${item.quantity > 1 ? ` × ${htmlEscape(item.quantity)}` : ''}</span><span>${htmlEscape(money(Number(item.price) * Number(item.quantity || 1)))}</span></li>`).join('');
    const hidden = ['merchant_id', 'session_id', 'token', 'merchant_transaction_id'].map(name => `<input type="hidden" name="${name}" value="${htmlEscape(form.get(name) || '')}">`).join('');
    return page('Confirm your payment', `
      <p class="eyebrow">CHECKOUT GATEWAY · SIMULATION</p>
      <h1>Confirm your payment</h1>
      <p id="payment-description">Paying <strong>${htmlEscape(money(session.amountRupees))}</strong> to <strong>Hamro Goods</strong>.</p>
      ${lines ? `<ul class="gateway-lines">${lines}</ul>` : ''}
      <div class="payment-total"><span>Total</span><strong>${htmlEscape(money(session.amountRupees))}</strong></div>
      ${notice ? `<p class="status-message" role="alert">${htmlEscape(notice)}</p>` : ''}
      <form method="POST" action="${MOCK_PREFIX}api/checkout/confirm" class="gateway-form">
        ${hidden}
        <label for="wallet-phone">Hamro Pay number</label>
        <input id="wallet-phone" name="phone_number" inputmode="numeric" autocomplete="off" value="${htmlEscape(TEST_WALLET.phone)}" required>
        <label for="wallet-pin">T-PIN</label>
        <input id="wallet-pin" name="pin" type="password" inputmode="numeric" autocomplete="off" value="${htmlEscape(TEST_WALLET.pin)}" required>
        <label for="wallet-otp">OTP</label>
        <input id="wallet-otp" name="otp" inputmode="numeric" autocomplete="off" value="${htmlEscape(TEST_WALLET.otp)}" required>
        <button class="primary" type="submit" name="action" value="pay">Pay ${htmlEscape(money(session.amountRupees))} →</button>
        <button class="secondary" type="submit" name="action" value="cancel" formnovalidate>Cancel payment</button>
      </form>
      <details class="product-details"><summary>Test credentials</summary><p>Number <strong>${TEST_WALLET.phone}</strong>, T-PIN <strong>${TEST_WALLET.pin}</strong>, OTP <strong>${TEST_WALLET.otp}</strong> completes the payment. T-PIN <strong>${DECLINE_PIN}</strong> is declined. Number <strong>${PENDING_PHONE}</strong> stays pending, then settles a few seconds later.</p></details>`);
  }

  /** Browser-facing half: the hosted page and the redirect back to the merchant. */
  async function handle(path, form) {
    if (path === `${MOCK_PREFIX}api/checkout`) {
      const { error, session } = openSession(form);
      return error || { status: 200, html: paymentPage(session, form) };
    }
    if (path !== `${MOCK_PREFIX}api/checkout/confirm`) return errorPage('Not found.', 'This gateway endpoint does not exist.');

    const { error, session } = openSession(form);
    if (error) return error;
    const back = (url, txnId) => { const target = new URL(url); target.searchParams.set('MerchantTxnId', txnId); return { redirect: target.href }; };

    if (form.get('action') === 'cancel') {
      session.used = true;
      settle(session, 'FAILED');
      return back(session.failedRedirectionUrl, session.merchantTxnId);
    }
    const phone = (form.get('phone_number') || '').trim();
    const pin = (form.get('pin') || '').trim();
    const otp = (form.get('otp') || '').trim();
    if (!/^\d{10}$/.test(phone)) return { status: 200, html: paymentPage(session, form, 'Enter a 10-digit Hamro Pay number.') };
    if (pin === DECLINE_PIN) {
      session.used = true;
      settle(session, 'FAILED');
      return back(session.failedRedirectionUrl, session.merchantTxnId);
    }
    if (pin !== TEST_WALLET.pin || otp !== TEST_WALLET.otp) {
      return { status: 200, html: paymentPage(session, form, 'That T-PIN or OTP is not correct for this simulation.') };
    }
    session.used = true;
    if (phone === PENDING_PHONE) {
      // Authorised but not yet settled: Get Transaction reports PROCESSING for a while.
      transactions.set(session.merchantTxnId, { merchantTransactionId: session.merchantTxnId, trackingId: `demo-${session.sessionId.slice(0, 8)}`, status: 'PROCESSING', amount: 0, remarks: session.remarks || '', message: 'TRANSACTION IS BEING PROCESSED' });
      const timer = setTimeout(() => { timers.delete(timer); settle(session, 'COMPLETED'); }, PENDING_SETTLE_MS);
      timer.unref?.();
      timers.add(timer);
    } else {
      settle(session, 'COMPLETED');
    }
    return back(session.successRedirectionUrl, session.merchantTxnId);
  }

  const close = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
  return { fetcher, handle, close };
}

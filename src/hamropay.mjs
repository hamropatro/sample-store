// Hamro Pay Checkout adapter.
// Contract: https://hamropay.com.np/checkout/developer/reference/
//
// Three calls make up a checkout:
//   1. Create Session    POST {API_BASE_URL}/v1/checkout/sessionId   (merchant backend)
//   2. Checkout Proceed  POST {GATEWAY_URL}/api/checkout             (merchant frontend, form POST)
//   3. Get Transaction   POST {API_BASE_URL}/v1/checkout/transaction (merchant backend)
//
// Amount units differ by direction and are a common source of bugs:
//   - Create Session sends `transactionAmount` in PAISA (Rs.10 = 1000).
//   - Get Transaction and the webhook return `amount` in RUPEES (9.99 = Rs.9.99).
// Orders in this sample are stored in rupees, so every outbound amount is converted.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Hamro Pay accepts Rs.10 to Rs.50,000 per transaction.
export const MIN_AMOUNT_PAISA = 1000;
export const MAX_AMOUNT_PAISA = 5000000;
const MAX_TXN_ID_LENGTH = 25;
const MAX_REMARKS_LENGTH = 250;
const RESPONSE_LIMIT_BYTES = 100000;
const REQUEST_TIMEOUT_MS = 15000;

export const toPaisa = rupees => Math.round(Number(rupees) * 100);

// Every signature is Base64(HMAC-SHA512(values joined by ',', clientSecret)). The joiner
// carries no escaping, so a comma inside a field would let two different tuples produce the
// same signature. No signed field may contain one; callers handling untrusted input should
// screen with `isSignable` first rather than letting this throw.
export const isSignable = values => values.every(value => !String(value).includes(','));
export function sign(values, secret) {
  if (!isSignable(values)) throw new Error('Signed fields must not contain commas.');
  return createHmac('sha512', secret).update(values.join(','), 'utf8').digest('base64');
}

/** Build the exact Create Session body. The signature must cover the values actually sent. */
export function sessionRequest(order, config) {
  const request = {
    merchantTxnId: order.id,
    merchantId: config.merchantId,
    // Sent as a string so the signed text and the serialized JSON can never disagree.
    transactionAmount: String(toPaisa(order.amount)),
    successRedirectionUrl: `${config.origin}/payment/success`,
    failedRedirectionUrl: `${config.origin}/payment/failure`,
    remarks: `Sample T-shirt order ${order.id}`.slice(0, MAX_REMARKS_LENGTH),
    productList: order.lines.map(line => ({
      name: `${line.name} · ${line.size}`,
      imageUrl: new URL(line.image, config.origin).href,
      description: `Sample merchandise, size ${line.size}`,
      price: line.price, // Display price in rupees, unlike transactionAmount.
      quantity: line.quantity,
    })),
    metadata: { orderId: order.id, source: 'hamropay-sample-store' },
    ...(config.commission ? { clientCommissionConfig: config.commission } : {}),
  };
  if (request.merchantTxnId.length > MAX_TXN_ID_LENGTH) throw new Error(`merchantTxnId must be at most ${MAX_TXN_ID_LENGTH} characters.`);
  const paisa = Number(request.transactionAmount);
  if (paisa < MIN_AMOUNT_PAISA || paisa > MAX_AMOUNT_PAISA) {
    throw new Error(`Hamro Pay accepts NPR 10 to NPR 50,000 per transaction. This order is NPR ${order.amount}.`);
  }
  return request;
}

async function post(url, body, signature, config, fetcher) {
  const options = {
    method: 'POST',
    headers: {
      'Signature': signature,
      'Client-Id': config.clientId,
      'Client-API-Key': config.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Hamro Pay closes the TCP connection after each response without marking it
      // closed, so Node's pooled keep-alive socket is already dead on the next call and
      // fails as UND_ERR_SOCKET on every second request. Opting out of connection reuse
      // makes each call deterministic. Measured: keep-alive 4/8 requests fail, close 8/8 pass.
      'Connection': 'close',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  const host = new URL(url).host;
  let response;
  let text;
  try {
    response = await fetcher(new URL(url), options);
    // Reading the body is inside the guard on purpose: a connection reset part-way
    // through the response surfaces here, not on the call above.
    text = await response.text();
  } catch (error) {
    // undici reports every transport failure as TypeError('fetch failed' | 'terminated'),
    // which tells an integrator nothing. Anything else (an assertion from an injected
    // fetcher, for instance) is left alone.
    if (error?.name === 'TimeoutError') throw new Error('Hamro Pay did not respond within 15s. A session may still have been created; check the merchant portal before retrying.');
    if (error instanceof TypeError) throw new Error(`Could not reach Hamro Pay at ${host} (${error.cause?.code || error.message}). Check network access; UAT may also reset connections under repeated requests.`);
    throw error;
  }
  if (text.length > RESPONSE_LIMIT_BYTES) throw new Error('Hamro Pay response was too large.');
  let payload;
  try { payload = JSON.parse(text); } catch { payload = null; }
  if (!response.ok) {
    // Log the API's own wording for the operator; the customer gets a stable message, since
    // upstream text is untrusted and may describe credential or environment detail.
    if (typeof payload?.message === 'string') console.error(`Hamro Pay HTTP ${response.status}: ${payload.message}`);
    throw new Error(`Hamro Pay returned HTTP ${response.status}. Check your credentials and endpoints.`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('Hamro Pay did not return a JSON object. Confirm the endpoint URL.');
  return payload;
}

/** Step 1. Returns the session id alongside the request it was created from. */
export async function createSession(order, config, fetcher = fetch) {
  const request = sessionRequest(order, config);
  const signature = sign([request.merchantTxnId, request.transactionAmount, request.merchantId, config.clientId, config.apiKey], config.clientSecret);
  const session = await post(config.sessionUrl, request, signature, config, fetcher);
  if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Create Session did not return a sessionId.');
  if (session.merchantId !== config.merchantId) throw new Error('Create Session returned a different merchant ID than this store uses.');
  return { sessionId: session.sessionId, request };
}

/**
 * Step 2 (server half). The gateway token is a signature over different fields than the
 * header signature, and it is generated here — the Create Session response never carries it.
 */
export function checkoutFields({ sessionId, request }, config) {
  const token = sign([config.merchantId, request.merchantTxnId, sessionId, request.transactionAmount, config.clientId, config.apiKey], config.clientSecret);
  return {
    merchant_id: config.merchantId,
    session_id: sessionId,
    token,
    merchant_transaction_id: request.merchantTxnId,
    remarks: request.remarks,
  };
}

/** Create a session and return only the fields that may reach the browser. */
export async function startCheckout(order, config, fetcher = fetch) {
  return checkoutFields(await createSession(order, config, fetcher), config);
}

/** Step 3. Authoritative payment status; `amount` comes back in rupees. */
export async function getTransaction(order, config, fetcher = fetch) {
  const body = { merchantId: config.merchantId, merchantTxnId: order.id };
  const signature = sign([order.id, config.merchantId, config.clientId, config.apiKey], config.clientSecret);
  return post(config.transactionUrl, body, signature, config, fetcher);
}

/**
 * A payment may only settle an order when the transaction id matches and, for COMPLETED,
 * the rupee amount matches too. Unfinished states legitimately report amount 0, so the
 * amount is not checked for them.
 */
export function matchesPayment(payment, order) {
  if (payment?.merchantTransactionId !== order.id) return false;
  if (payment.status !== 'COMPLETED') return true;
  const paid = Number(payment.amount);
  return Number.isFinite(paid) && paid === Number(order.amount);
}

/**
 * Hamro Pay signs the webhook's `amount` as its own serialization of a double, which may be
 * "1200", "1200.0" or "1200.00" depending on the sender. Every candidate is rendered from the
 * PARSED number, never from the raw bytes: reading the raw text separately would let a body
 * with a duplicate "amount" key authenticate one value while the order settles on another.
 */
function amountCandidates(amount) {
  return new Set([String(amount), amount.toFixed(2), `${amount}.0`]);
}

const equals = (a, b) => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Signature string is merchantTxnId,merchantId,status,amount signed with the webhook secret. */
export function verifyWebhook(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !body) return false;
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount)) return false;
  const fields = ['merchantTxnId', 'merchantId', 'status'];
  if (fields.some(key => typeof body[key] !== 'string' || !body[key])) return false;
  const prefix = fields.map(key => body[key]);
  if (!isSignable(prefix)) return false;
  let valid = false;
  // Check every candidate so the work does not depend on which one matched.
  for (const amount of amountCandidates(body.amount)) {
    if (equals(sign([...prefix, amount], secret), signature)) valid = true;
  }
  return valid;
}

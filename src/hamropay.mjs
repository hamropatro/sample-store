import { createHmac, timingSafeEqual } from 'node:crypto';

export const sign = (values, secret) => createHmac('sha512', secret).update(values.join(','), 'utf8').digest('base64');
export function sessionRequest(order, config) {
  return {
    merchantId: config.merchantId, merchantTxnId: order.id,
    amount: order.amount, currency: 'NPR', userSecret: config.userSecret,
    successUrl: `${config.origin}/payment/return`, failureUrl: `${config.origin}/payment/return`,
    remarks: `Sample T-shirt order ${order.id}`,
    ...(config.commission ? { clientCommissionConfig: config.commission } : {}),
    productList: order.lines.map(line => ({ name: `${line.name} · ${line.size}`, description: 'Sample merchandise', price: line.price, quantity: line.quantity })),
  };
}
async function request(url, method, body, signature, config, fetcher) {
  const destination = new URL(url);
  const headers = { 'Signature': signature, 'Client-Id': config.clientId, 'Client-Api-Key': config.apiKey, 'Content-Type': 'application/json' };
  const options = { method, headers, redirect: 'error', signal: AbortSignal.timeout(15000) };
  if (method === 'GET') for (const [key, value] of Object.entries(body)) destination.searchParams.set(key, String(value));
  else options.body = JSON.stringify(body);
  const response = await fetcher(destination, options);
  if (!response.ok) throw new Error(`Hamro Pay returned HTTP ${response.status}. Check your sandbox configuration.`);
  const text = await response.text();
  if (text.length > 100000) throw new Error('Hamro Pay response was too large.');
  try { return JSON.parse(text); } catch { throw new Error('Hamro Pay did not return JSON. Confirm the endpoint URL.'); }
}
export async function createSession(order, config, fetcher = fetch) {
  const body = sessionRequest(order, config);
  const signature = sign([body.amount, body.currency, body.merchantId, body.merchantTxnId, body.userSecret], config.clientSecret);
  const session = await request(config.createUrl, config.createMethod, body, signature, config, fetcher);
  if (session.merchantTxnId !== order.id || session.merchantId !== config.merchantId || Number(session.amount) !== order.amount) throw new Error('The session response does not match this order.');
  for (const key of ['session_id', 'token']) if (typeof session[key] !== 'string' || !session[key]) throw new Error(`The session response is missing ${key}. Confirm its format with Hamro Pay.`);
  return { merchant_id: config.merchantId, merchant_transaction_id: order.id, session_id: session.session_id, token: session.token };
}
export async function getTransaction(order, config, fetcher = fetch) {
  const body = { merchantId: config.merchantId, merchantTxnId: order.id };
  return request(config.transactionUrl, config.transactionMethod, body, sign([order.id, config.merchantId, config.clientId, config.apiKey], config.clientSecret), config, fetcher);
}
export function matchesPayment(payment, order) {
  return payment?.merchantTransactionId === order.id && Number.isFinite(Number(payment.amount)) && Number(payment.amount) === order.amount;
}
export function verifyWebhook(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !body || typeof body.amount !== 'number' || !Number.isFinite(body.amount)) return false;
  const fields = ['merchantTxnId', 'merchantId', 'status'];
  if (fields.some(key => typeof body[key] !== 'string' || !body[key])) return false;
  const expected = Buffer.from(sign([...fields.map(key => body[key]), body.amount], secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

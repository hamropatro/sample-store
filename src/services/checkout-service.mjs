import { randomBytes } from 'node:crypto';
import { startCheckout } from '../hamropay/index.mjs';
import { conflict, badGateway, badRequest } from '../errors.mjs';
import { log } from '../log.mjs';

const ORDER_ID_BYTES = 10; // "HP" + 20 hex characters stays inside the 25-character limit.
const newOrderId = () => `HP${randomBytes(ORDER_ID_BYTES).toString('hex')}`;

/**
 * Turns a priced cart into an order with a Hamro Pay session attached.
 *
 * Checkout is the one place a double-submit costs real money, so it is guarded twice:
 * an in-flight map collapses concurrent requests that share an Idempotency-Key, and a
 * lookup by that key returns the existing order once the request has completed.
 */
export function createCheckoutService({ config, store, fetcher = fetch }) {
  const inFlight = new Map();
  const destination = order => ({ orderId: order.id, url: `/checkout/redirect?id=${order.id}` });

  async function create(owner, requestKey, cart) {
    const order = { id: newOrderId(), owner, requestKey, ...cart, status: 'PENDING', createdAt: new Date().toISOString() };
    await store.save(order);
    log.info('checkout.started', { orderId: order.id, amount: order.amount, items: order.lines.length });
    try {
      order.checkoutFields = await startCheckout(order, config, fetcher);
    } catch (error) {
      await store.save({ ...order, status: 'SESSION_ERROR' });
      log.error('checkout.session_failed', { orderId: order.id, code: error.code, upstreamStatus: error.status, reason: error.message });
      throw badGateway(error.message, { code: error.code || 'SESSION_FAILED' });
    }
    order.sessionReady = true;
    await store.save(order);
    log.info('checkout.session_created', { orderId: order.id, sessionId: order.checkoutFields.session_id, amount: order.amount });
    return destination(order);
  }

  async function start({ owner, requestKey, cart }) {
    if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(requestKey)) throw badRequest('Missing or malformed Idempotency-Key header.', { code: 'BAD_IDEMPOTENCY_KEY' });
    const fingerprint = JSON.stringify(cart.lines);
    const lockKey = `${owner}:${requestKey}`;

    const pending = inFlight.get(lockKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw conflict('This checkout ID belongs to a different cart.', { code: 'CART_CHANGED' });
      return pending.promise;
    }
    const existing = store.find(order => order.owner === owner && order.requestKey === requestKey);
    if (existing) {
      if (JSON.stringify(existing.lines) !== fingerprint) throw conflict('This checkout ID belongs to a different cart.', { code: 'CART_CHANGED' });
      if (!existing.sessionReady) throw conflict('A previous checkout attempt needs review. Start a new checkout.', { code: 'SESSION_INCOMPLETE' });
      log.debug('checkout.reused', { orderId: existing.id });
      return destination(existing);
    }

    const promise = create(owner, requestKey, cart);
    inFlight.set(lockKey, { fingerprint, promise });
    try { return await promise; } finally { inFlight.delete(lockKey); }
  }

  return { start };
}

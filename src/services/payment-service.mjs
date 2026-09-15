import { getTransaction, matchesPayment, transactionIdOf } from '../hamropay/index.mjs';
import { GatewayError, badGateway } from '../errors.mjs';
import { log } from '../log.mjs';

// Every status the API is documented to report, plus NOT_INITIATED from its samples.
const KNOWN_STATES = new Set(['PENDING', 'PROCESSING', 'FAILED', 'NOT_INITIATED', 'COMPLETED']);

/**
 * Decides whether an order is paid. Nothing else in the app may set status to PAID:
 * a payment is only ever applied from an answer Hamro Pay gave us, either through
 * Get Transaction or through a signature-verified webhook.
 */
export function createPaymentService({ config, store, fetcher = fetch }) {
  async function apply(order, payment, source) {
    if (!matchesPayment(payment, order) || !KNOWN_STATES.has(payment.status)) {
      log.warn('payment.rejected', {
        orderId: order.id, source, reported: payment?.status,
        expectedId: order.id, gotId: transactionIdOf(payment),
        expectedAmount: order.amount, gotAmount: payment?.amount,
      });
      throw badGateway('Payment details did not match your order. The order has not been marked paid.', { code: 'PAYMENT_MISMATCH' });
    }
    const before = order.status;
    const updated = await store.update(order.id, latest => {
      if (latest.status === 'PAID') return latest; // Paid is terminal; late or repeated events cannot undo it.
      return {
        ...latest,
        status: payment.status === 'COMPLETED' ? 'PAID' : payment.status,
        ...(payment.status === 'COMPLETED' ? { paidAt: new Date().toISOString() } : {}),
      };
    });
    if (updated.status !== before) log.info('payment.status_changed', { orderId: order.id, source, from: before, to: updated.status, amount: updated.amount });
    else log.debug('payment.unchanged', { orderId: order.id, source, status: updated.status });
    return updated;
  }

  /** Ask Hamro Pay directly. The browser's redirect is never trusted for this. */
  async function verify(order) {
    if (order.status === 'PAID') return order;
    let payment;
    try {
      payment = await getTransaction(order, config, fetcher);
    } catch (error) {
      if (error instanceof GatewayError) {
        log.error('payment.verify_failed', { orderId: order.id, code: error.code, upstreamStatus: error.status, reason: error.message });
        if (error.isAuthFailure) throw badGateway('Payment verification is misconfigured. The store could not authenticate with Hamro Pay.', { code: 'GATEWAY_AUTH' });
        throw badGateway('Payment verification is unavailable right now. Your order is unchanged; try checking again.', { code: 'GATEWAY_UNAVAILABLE' });
      }
      throw error;
    }
    log.info('payment.verified', { orderId: order.id, reported: payment.status, trackingId: payment.trackingId || undefined });
    return apply(order, payment, 'verify');
  }

  return { apply, verify };
}

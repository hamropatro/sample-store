import { sign } from './signature.mjs';
import { post } from './client.mjs';

/**
 * The published reference names this response field `merchantTransactionId`, but the
 * live API returns `merchantTxnId`. Accept either: reading only the documented name
 * makes every verification look like a mismatch and fail the payment.
 */
export const transactionIdOf = payment => payment?.merchantTransactionId ?? payment?.merchantTxnId;

/** Step 3. The authoritative payment status. `amount` comes back in rupees. */
export async function getTransaction(order, config, fetcher = fetch) {
  const body = { merchantId: config.merchantId, merchantTxnId: order.id };
  const signature = sign([order.id, config.merchantId, config.clientId, config.apiKey], config.clientSecret);
  return post({ url: config.transactionUrl, body, signature, config, fetcher, operation: 'get-transaction' });
}

/**
 * A payment may settle an order only when the transaction id matches and, for
 * COMPLETED, the rupee amount matches too. Unfinished states legitimately report
 * amount 0, so the amount is not checked for them.
 */
export function matchesPayment(payment, order) {
  if (transactionIdOf(payment) !== order.id) return false;
  if (payment.status !== 'COMPLETED') return true;
  const paid = Number(payment.amount);
  return Number.isFinite(paid) && paid === Number(order.amount);
}

// Create Session and the gateway hand-off.
// Reference: https://hamropay.com.np/checkout/developer/reference/
//
// Amount units differ by direction and are the easiest thing to get wrong:
//   - Create Session sends `transactionAmount` in PAISA (Rs.10 = 1000).
//   - Get Transaction and the webhook return `amount` in RUPEES.
//   - `productList[].price` is in rupees too, because it is only for display.
import { sign } from './signature.mjs';
import { post } from './client.mjs';
import { GatewayError } from '../errors.mjs';

// Hamro Pay accepts Rs.10 to Rs.50,000 per transaction, for KYC-verified users only.
export const MIN_AMOUNT_PAISA = 1000;
export const MAX_AMOUNT_PAISA = 5000000;
const MAX_TXN_ID_LENGTH = 25;
const MAX_REMARKS_LENGTH = 250;

export const toPaisa = rupees => Math.round(Number(rupees) * 100);

/** Build the exact Create Session body. The signature must cover the values actually sent. */
export function sessionRequest(order, config) {
  const request = {
    merchantTxnId: order.id,
    merchantId: config.merchantId,
    // Sent as a string, matching the published samples, so the signed text and the
    // serialized JSON can never disagree.
    transactionAmount: String(toPaisa(order.amount)),
    successRedirectionUrl: `${config.origin}/payment/success`,
    failedRedirectionUrl: `${config.origin}/payment/failure`,
    remarks: `Sample T-shirt order ${order.id}`.slice(0, MAX_REMARKS_LENGTH),
    productList: order.lines.map(line => ({
      name: `${line.name} - ${line.size}`,
      imageUrl: new URL(line.image, config.origin).href,
      description: `Sample merchandise, size ${line.size}`,
      price: line.price,
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

/** Step 1. Returns the session id alongside the request it was created from. */
export async function createSession(order, config, fetcher = fetch) {
  const request = sessionRequest(order, config);
  const signature = sign([request.merchantTxnId, request.transactionAmount, request.merchantId, config.clientId, config.apiKey], config.clientSecret);
  const session = await post({ url: config.sessionUrl, body: request, signature, config, fetcher, operation: 'create-session' });
  if (typeof session.sessionId !== 'string' || !session.sessionId) throw new GatewayError('Create Session did not return a sessionId.', { code: 'NO_SESSION' });
  if (session.merchantId !== config.merchantId) throw new GatewayError('Create Session returned a different merchant ID than this store uses.', { code: 'MERCHANT_MISMATCH' });
  return { sessionId: session.sessionId, request };
}

/**
 * Step 2, server half. The gateway token is a signature over different fields, in a
 * different order, than the header signature -- and it is generated here. The Create
 * Session response carries only { sessionId, merchantId }; it never returns a token.
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

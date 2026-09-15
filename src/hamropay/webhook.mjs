import { sign, signatureMatches, isSignable } from './signature.mjs';

/**
 * Hamro Pay signs the webhook's `amount` as its own serialization of a double, which
 * may arrive as "1200", "1200.0" or "1200.00". Every candidate is rendered from the
 * PARSED number, never from the raw bytes: reading the raw text separately would let
 * a body with a duplicate "amount" key authenticate one value while the order settles
 * on another.
 */
const amountCandidates = amount => new Set([String(amount), amount.toFixed(2), `${amount}.0`]);

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
    if (signatureMatches(sign([...prefix, amount], secret), signature)) valid = true;
  }
  return valid;
}

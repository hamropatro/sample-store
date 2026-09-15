import { createHmac, timingSafeEqual } from 'node:crypto';

// Every Hamro Pay signature is Base64(HMAC-SHA512(values joined by ',', clientSecret)).
// The joiner carries no escaping, so a comma inside a field would let two different
// tuples produce the same signature. Callers handling untrusted input screen with
// `isSignable` first rather than letting `sign` throw.
export const isSignable = values => values.every(value => !String(value).includes(','));

export function sign(values, secret) {
  if (!isSignable(values)) throw new Error('Signed fields must not contain commas.');
  return createHmac('sha512', secret).update(values.join(','), 'utf8').digest('base64');
}

/** Constant-time string comparison, safe for values of differing length. */
export function signatureMatches(expected, received) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(received), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

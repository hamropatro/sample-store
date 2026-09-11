import { GatewayError } from '../errors.mjs';
import { log } from '../log.mjs';

const REQUEST_TIMEOUT_MS = 15000;
const RESPONSE_LIMIT_BYTES = 100000;

/**
 * One signed POST to the Hamro Pay API.
 *
 * Every call carries the three documented headers, plus `Connection: close`: the API
 * drops the TCP connection after each response without marking it closed, so Node's
 * pooled keep-alive socket is already dead on the next call and fails as
 * UND_ERR_SOCKET. Measured against UAT: keep-alive fails every second request.
 */
export async function post({ url, body, signature, config, fetcher = fetch, operation }) {
  const host = new URL(url).host;
  const startedAt = process.hrtime.bigint();
  let response;
  let text;
  try {
    response = await fetcher(new URL(url), {
      method: 'POST',
      headers: {
        'Signature': signature,
        'Client-Id': config.clientId,
        'Client-API-Key': config.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Connection': 'close',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Reading the body is inside the guard on purpose: a connection reset part-way
    // through the response surfaces here, not on the call above.
    text = await response.text();
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new GatewayError(`Hamro Pay did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. A request may still have been accepted; check the merchant portal before retrying.`, { code: 'TIMEOUT', cause: error });
    }
    // undici reports every transport failure as TypeError('fetch failed' | 'terminated'),
    // which tells an integrator nothing. Anything else is left alone.
    if (error instanceof TypeError) {
      throw new GatewayError(`Could not reach Hamro Pay at ${host} (${error.cause?.code || error.message}).`, { code: 'UNREACHABLE', cause: error });
    }
    throw error;
  }

  const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
  if (text.length > RESPONSE_LIMIT_BYTES) throw new GatewayError('Hamro Pay sent a response that was too large to parse.', { code: 'OVERSIZED' });
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* handled below */ }

  if (!response.ok) {
    // The API's own wording goes to the operator's log, never to the customer: it is
    // untrusted text and may describe credential or environment detail.
    log.error('hamropay.error', { operation, status: response.status, ms, message: typeof payload?.message === 'string' ? payload.message : undefined, code: payload?.code });
    throw new GatewayError(`Hamro Pay rejected the ${operation} request (HTTP ${response.status}).`, { status: response.status, code: payload?.code });
  }
  if (!payload || typeof payload !== 'object') throw new GatewayError(`Hamro Pay did not return a JSON object for ${operation}.`, { code: 'MALFORMED' });
  log.debug('hamropay.ok', { operation, status: response.status, ms });
  return payload;
}

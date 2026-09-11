import { createHmac, randomBytes } from 'node:crypto';
import { signatureMatches } from '../hamropay/signature.mjs';
import { forbidden, notFound, badRequest, unsupportedMedia, payloadTooLarge, tooManyRequests } from '../errors.mjs';

const SESSION_COOKIE = /(?:^|;\s*)sample_session=([A-Za-z0-9_-]{32})(?:;|$)/;
const MAX_BODY_BYTES = 16384;
const RATE_LIMIT = { max: 30, windowMs: 60000 };
const COOKIE_MAX_AGE = 604800;

/** Per-browser identity, CSRF tokens and rate limiting. Shared across requests. */
export function createSecurity(store) {
  const buckets = new Map();
  return {
    csrfFor: owner => createHmac('sha256', store.secret).update(owner).digest('hex'),
    consume(owner) {
      const now = Date.now();
      if (buckets.size > 1000) for (const [key, bucket] of buckets) if (bucket.until < now) buckets.delete(key);
      let bucket = buckets.get(owner);
      if (!bucket || bucket.until < now) { bucket = { count: 0, until: now + RATE_LIMIT.windowMs }; buckets.set(owner, bucket); }
      if (++bucket.count > RATE_LIMIT.max) throw tooManyRequests('Too many requests. Try again in a minute.', { code: 'RATE_LIMITED' });
    },
  };
}

/** Everything a route handler needs for one request. */
export function createContext({ req, res, config, store, security }) {
  let setCookie;
  let owner = SESSION_COOKIE.exec(req.headers.cookie || '')?.[1];
  if (!owner) {
    owner = randomBytes(24).toString('base64url');
    setCookie = `sample_session=${owner}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}${config.secure ? '; Secure' : ''}`;
  }

  const gatewayOrigin = new URL(config.gatewayUrl).origin;
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    // form-action must allow the gateway: the hand-off page POSTs a form to it.
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${gatewayOrigin}`,
    ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
  };

  const url = new URL(req.url, config.origin);
  const send = (status, body, type) => {
    res.writeHead(status, { ...headers, 'Content-Type': type });
    res.end(body);
    return status;
  };

  return {
    req, res, url, owner, config, store,
    method: req.method,
    path: url.pathname,
    csrf: () => security.csrfFor(owner),

    json: (status, data) => send(status, JSON.stringify(data), 'application/json; charset=utf-8'),
    html: (status, markup) => send(status, markup, 'text/html; charset=utf-8'),
    bytes: (status, buffer, type) => send(status, buffer, type),

    /** Reads the raw request body, refusing anything oversized or of the wrong type. */
    async text(expectedType) {
      if (!String(req.headers['content-type'] || '').startsWith(expectedType)) throw unsupportedMedia(`Send ${expectedType}.`, { code: 'BAD_CONTENT_TYPE' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw payloadTooLarge('Request is too large.', { code: 'BODY_TOO_LARGE' });
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    async body() {
      const raw = await this.text('application/json');
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed;
      } catch { throw badRequest('Send a JSON object.', { code: 'BAD_JSON' }); }
    },

    /** Same-origin check plus a per-session CSRF token, then the rate limit. */
    protect() {
      if (req.headers.origin !== config.origin) throw forbidden('Open the store at its configured APP_URL and try again.', { code: 'BAD_ORIGIN' });
      if (!signatureMatches(security.csrfFor(owner), String(req.headers['x-csrf-token'] || ''))) throw forbidden('Refresh the page and try again.', { code: 'BAD_CSRF' });
      security.consume(owner);
    },

    /** Orders belong to the browser that created them. */
    owned(id) {
      const order = store.get(id);
      if (!order || order.owner !== owner) throw notFound('Order not found in this browser.', { code: 'ORDER_NOT_FOUND' });
      return order;
    },

    /** The shape of an order the browser is allowed to see. */
    publicOrder: order => ({ id: order.id, status: order.status, amount: order.amount, currency: 'NPR', lines: order.lines, createdAt: order.createdAt }),
  };
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { product, priceCart } from './catalog.mjs';
import { startCheckout, getTransaction, matchesPayment, verifyWebhook } from './hamropay.mjs';
import { createMockGateway, MOCK_PREFIX } from './mock-gateway.mjs';
import { htmlEscape } from './html.mjs';
const apiError = (status, message) => Object.assign(new Error(message), { status });
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const states = new Set(['PENDING', 'PROCESSING', 'FAILED', 'NOT_INITIATED', 'COMPLETED']);

export function createApp({ config, store, publicDir, fetcher }) {
  // Demo mode talks to a built-in gateway over the documented protocol instead of skipping
  // it, so both modes exercise exactly the same checkout code.
  const mock = config.mode === 'demo' ? createMockGateway(config) : null;
  const send = fetcher || mock?.fetcher || fetch;
  const locks = new Map();
  const buckets = new Map();
  const csrfFor = owner => createHmac('sha256', store.secret).update(owner).digest('hex');
  function consume(owner) {
    const now = Date.now();
    if (buckets.size > 1000) for (const [key, bucket] of buckets) if (bucket.until < now) buckets.delete(key);
    let bucket = buckets.get(owner);
    if (!bucket || bucket.until < now) { bucket = { count: 0, until: now + 60000 }; buckets.set(owner, bucket); }
    if (++bucket.count > 30) throw apiError(429, 'Too many requests. Try again in a minute.');
  }
  const handle = async function handle(req, res) {
    let cookieHeader;
    const header = req.headers.cookie || '';
    let owner = /(?:^|;\s*)sample_session=([A-Za-z0-9_-]{32})(?:;|$)/.exec(header)?.[1];
    if (!owner) { owner = randomBytes(24).toString('base64url'); cookieHeader = `sample_session=${owner}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${config.secure ? '; Secure' : ''}`; }
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" + (config.gatewayUrl ? ` ${new URL(config.gatewayUrl).origin}` : ''),
      ...(cookieHeader ? { 'Set-Cookie': cookieHeader } : {}),
    };
    const reply = (status, data, type = 'application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
    const owned = id => { const order = store.get(id); if (!order || order.owner !== owner) throw apiError(404, 'Order not found in this browser.'); return order; };
    const publicOrder = order => ({ id: order.id, status: order.status, amount: order.amount, currency: 'NPR', lines: order.lines, mode: order.mode, createdAt: order.createdAt });
    const readBody = async type => {
      if (!String(req.headers['content-type'] || '').startsWith(type)) throw apiError(415, `Send ${type}.`);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16384) throw apiError(413, 'Request is too large.'); chunks.push(chunk); }
      return Buffer.concat(chunks).toString('utf8');
    };
    const parseBody = async () => {
      const text = await readBody('application/json');
      try { const body = JSON.parse(text); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw apiError(400, 'Send a JSON object.'); }
    };
    const parseForm = async () => new URLSearchParams(await readBody('application/x-www-form-urlencoded'));
    const protect = () => {
      if (req.headers.origin !== config.origin) throw apiError(403, 'Open the store at its configured APP_URL and try again.');
      const token = Buffer.from(String(req.headers['x-csrf-token'] || ''));
      const expected = Buffer.from(csrfFor(owner));
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw apiError(403, 'Refresh the page and try again.');
      consume(owner);
    };
    async function applyPayment(order, payment) {
      if (!matchesPayment(payment, order) || !states.has(payment.status)) throw apiError(502, 'Payment details did not match your order. The order has not been marked paid.');
      return store.update(order.id, latest => {
        if (latest.status === 'PAID') return latest;
        return { ...latest, status: payment.status === 'COMPLETED' ? 'PAID' : payment.status, ...(payment.status === 'COMPLETED' ? { paidAt: new Date().toISOString() } : {}) };
      });
    }
    try {
      const url = new URL(req.url, config.origin);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/store') return reply(200, { product, mode: config.mode, csrf: csrfFor(owner) });
      if (req.method === 'GET' && path === '/api/order') return reply(200, publicOrder(owned(url.searchParams.get('id'))));
      if (req.method === 'POST' && path === '/api/checkout') {
        protect();
        const { items } = await parseBody();
        let cart; try { cart = priceCart(items); } catch (error) { throw apiError(400, error.message); }
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(key)) throw apiError(400, 'Missing checkout request ID.');
        const lockKey = owner + key;
        const fingerprint = JSON.stringify(cart.lines);
        if (locks.has(lockKey)) {
          const pending = locks.get(lockKey);
          if (pending.fingerprint !== fingerprint) throw apiError(409, 'This checkout ID belongs to a different cart.');
          return reply(200, await pending.promise);
        }
        const existing = store.find(order => order.owner === owner && order.requestKey === key);
        if (existing) {
          if (JSON.stringify(existing.lines) !== JSON.stringify(cart.lines)) throw apiError(409, 'This checkout ID belongs to a different cart.');
          if (existing.sessionReady) return reply(200, { orderId: existing.id, url: `/checkout/redirect?id=${existing.id}` });
          throw apiError(409, 'A previous checkout attempt needs review. Start a new checkout attempt.');
        }
        const promise = (async () => {
          let order = { id: `HP${randomBytes(10).toString('hex')}`, owner, requestKey: key, ...cart, status: 'PENDING', mode: config.mode, createdAt: new Date().toISOString() };
          await store.save(order);
          try { order.checkoutFields = await startCheckout(order, config, send); }
          catch (error) { await store.save({ ...order, status: 'SESSION_ERROR' }); throw apiError(502, error.message); }
          order.sessionReady = true;
          await store.save(order);
          return { orderId: order.id, url: `/checkout/redirect?id=${order.id}` };
        })();
        locks.set(lockKey, { fingerprint, promise });
        try { return reply(200, await promise); } finally { locks.delete(lockKey); }
      }
      if (req.method === 'GET' && path === '/checkout/redirect') {
        const order = owned(url.searchParams.get('id'));
        if (order.mode !== config.mode || !order.checkoutFields || order.status === 'PAID') throw apiError(409, 'Checkout is not available for this order.');
        const fields = Object.entries(order.checkoutFields).map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`).join('');
        const label = config.mode === 'demo' ? 'LOCAL SIMULATION · NO MONEY MOVES' : 'HAMRO PAY SANDBOX';
        const where = config.mode === 'demo' ? 'The next page is a local simulation of the checkout gateway.' : 'The next page is hosted by Hamro Pay.';
        return reply(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to checkout</title><link rel="stylesheet" href="/style.css"><body><div class="sample-banner">${htmlEscape(label)}</div><main class="payment-panel"><p class="eyebrow">SECURE CHECKOUT</p><h1>Continue to secure checkout</h1><p>Your order is NPR ${htmlEscape(order.amount)}. ${htmlEscape(where)}</p><form method="POST" action="${htmlEscape(config.gatewayUrl)}" enctype="application/x-www-form-urlencoded">${fields}<button class="primary" type="submit">Continue to Hamro Pay →</button></form><a href="/">← Back to the store</a></main></body></html>`, 'text/html; charset=utf-8');
      }
      if (mock && req.method === 'POST' && path.startsWith(MOCK_PREFIX)) {
        const result = await mock.handle(path, await parseForm());
        if (result.redirect) { res.writeHead(303, { ...headers, Location: result.redirect }); return res.end(); }
        return reply(result.status, result.html, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && path === '/api/order/verify') {
        protect(); const { id } = await parseBody(); const order = owned(id);
        if (order.mode !== config.mode) throw apiError(409, 'This order belongs to a different payment mode. Start a new order.');
        if (order.status === 'PAID') return reply(200, publicOrder(order));
        let payment; try { payment = await getTransaction(order, config, send); } catch { throw apiError(502, 'Payment verification is unavailable. Your order remains unconfirmed; try checking again.'); }
        return reply(200, publicOrder(await applyPayment(order, payment)));
      }
      if (req.method === 'POST' && path === '/api/webhooks/hamropay') {
        if (!config.webhookSecret) throw apiError(404, 'Webhook is not enabled.');
        const body = await parseBody();
        if (!verifyWebhook(body, req.headers.signature, config.webhookSecret) || body.merchantId !== config.merchantId) throw apiError(401, 'Invalid webhook.');
        const order = store.get(body.merchantTxnId);
        if (!order || order.mode !== config.mode) throw apiError(404, 'Unknown order.');
        await applyPayment(order, { merchantTransactionId: body.merchantTxnId, amount: body.amount, status: body.status });
        return reply(200, { received: true });
      }
      if (req.method === 'GET') {
        const staticFiles = { '/': ['index.html', '.html'], '/store.js': ['store.js', '.js'], '/style.css': ['style.css', '.css'], '/assets/everyday-tee.png': ['assets/everyday-tee.png', '.png'], '/payment/return': ['payment.html', '.html'], '/payment/success': ['payment.html', '.html'], '/payment/failure': ['payment.html', '.html'], '/payment.js': ['payment.js', '.js'] };
        const file = staticFiles[path];
        if (file) return reply(200, await readFile(new URL(file[0], publicDir)), mime[file[1]]);
      }
      throw apiError(404, 'Not found.');
    } catch (error) {
      // Never log request bodies, credentials, signatures, or session tokens.
      if (!error.status) console.error('Request failed:', error.code || error.name);
      if (!res.headersSent) reply(error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
      else res.end();
    }
  };
  handle.close = () => mock?.close();
  return handle;
}

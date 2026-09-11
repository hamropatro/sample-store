import { createSecurity, createContext } from './context.mjs';
import { createStaticHandler } from './static.mjs';
import { createCheckoutService } from '../services/checkout-service.mjs';
import { createPaymentService } from '../services/payment-service.mjs';
import { getStore } from './routes/store.mjs';
import { checkoutRoutes } from './routes/checkout.mjs';
import { orderRoutes } from './routes/orders.mjs';
import { webhookRoutes } from './routes/webhooks.mjs';
import { HttpError, notFound } from '../errors.mjs';
import { log } from '../log.mjs';

/**
 * Wires the application together:
 *   routes  -> thin HTTP handlers, no payment logic
 *   services-> checkout and payment decisions
 *   hamropay-> the provider adapter, the only place that talks to Hamro Pay
 */
export function createApp({ config, store, publicDir, fetcher = fetch }) {
  const security = createSecurity(store);
  const services = {
    checkout: createCheckoutService({ config, store, fetcher }),
    payments: createPaymentService({ config, store, fetcher }),
  };
  const checkout = checkoutRoutes(services);
  const orders = orderRoutes(services);
  const webhooks = webhookRoutes(services);
  const serveStatic = createStaticHandler(publicDir);

  const routes = [
    ['GET', '/api/store', getStore],
    ['GET', '/api/order', orders.get],
    ['POST', '/api/order/verify', orders.verify],
    ['POST', '/api/checkout', checkout.start],
    ['GET', '/checkout/redirect', checkout.handoff],
    ['POST', '/api/webhooks/hamropay', webhooks.receive],
  ];

  return async function handle(req, res) {
    const startedAt = process.hrtime.bigint();
    let ctx;
    let status = 500;
    try {
      ctx = createContext({ req, res, config, store, security });
      const route = routes.find(([method, path]) => method === req.method && path === ctx.path);
      if (route) status = await route[2](ctx);
      else if (req.method === 'GET' && await serveStatic(ctx)) status = 200;
      else throw notFound();
    } catch (error) {
      status = respondToError(res, ctx, error);
    } finally {
      const ms = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log[level]('http', { method: req.method, path: ctx?.path ?? req.url, status, ms });
    }
  };
}

/** Expected failures return their own message; anything else stays generic. */
function respondToError(res, ctx, error) {
  const expected = error instanceof HttpError;
  const status = expected ? error.status : 500;
  // Request bodies, credentials, signatures and session tokens never reach a log line.
  if (!expected) log.error('request.failed', { path: ctx?.path, reason: error?.message, code: error?.code });
  if (res.headersSent) { res.end(); return status; }
  const payload = expected ? { error: error.message, code: error.code } : { error: 'Something went wrong. Please try again.' };
  if (ctx) return ctx.json(status, payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
  return status;
}

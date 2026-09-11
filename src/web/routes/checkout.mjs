import { priceCart } from '../../catalog.mjs';
import { badRequest, conflict } from '../../errors.mjs';
import { handoffPage } from '../views.mjs';
import { log } from '../../log.mjs';

export function checkoutRoutes({ checkout }) {
  return {
    /** Prices the cart on the server, then opens a Hamro Pay session for it. */
    async start(ctx) {
      ctx.protect();
      const { items } = await ctx.body();
      let cart;
      // Prices come from the catalogue, never from the browser.
      try { cart = priceCart(items); } catch (error) { throw badRequest(error.message, { code: 'INVALID_CART' }); }
      const result = await checkout.start({ owner: ctx.owner, requestKey: ctx.req.headers['idempotency-key'], cart });
      return ctx.json(200, result);
    },

    /** Renders the form that posts the customer to the hosted checkout page. */
    handoff(ctx) {
      const order = ctx.owned(ctx.url.searchParams.get('id'));
      if (!order.checkoutFields || order.status === 'PAID') throw conflict('Checkout is not available for this order.', { code: 'CHECKOUT_CLOSED' });
      log.info('checkout.handoff', { orderId: order.id, gateway: new URL(ctx.config.gatewayUrl).host });
      return ctx.html(200, handoffPage(order, ctx.config));
    },
  };
}

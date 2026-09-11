import { verifyWebhook } from '../../hamropay/index.mjs';
import { notFound, unauthorized } from '../../errors.mjs';
import { log } from '../../log.mjs';

export function webhookRoutes({ payments }) {
  return {
    /**
     * Hamro Pay calls this when a payment settles. It is the path that still works
     * when the customer closes the tab before being redirected back.
     */
    async receive(ctx) {
      const { config, store } = ctx;
      if (!config.webhookSecret) throw notFound('Webhook is not enabled.', { code: 'WEBHOOK_DISABLED' });
      const body = await ctx.body();
      if (!verifyWebhook(body, ctx.req.headers.signature, config.webhookSecret) || body.merchantId !== config.merchantId) {
        log.warn('webhook.rejected', { orderId: body?.merchantTxnId, reason: 'signature or merchant mismatch' });
        throw unauthorized('Invalid webhook.', { code: 'BAD_WEBHOOK_SIGNATURE' });
      }
      const order = store.get(body.merchantTxnId);
      if (!order) {
        log.warn('webhook.unknown_order', { orderId: body.merchantTxnId });
        throw notFound('Unknown order.', { code: 'ORDER_NOT_FOUND' });
      }
      log.info('webhook.accepted', { orderId: body.merchantTxnId, reported: body.status, amount: body.amount });
      await payments.apply(order, { merchantTxnId: body.merchantTxnId, amount: body.amount, status: body.status }, 'webhook');
      return ctx.json(200, { received: true });
    },
  };
}

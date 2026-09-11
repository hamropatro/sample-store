export function orderRoutes({ payments }) {
  return {
    get: ctx => ctx.json(200, ctx.publicOrder(ctx.owned(ctx.url.searchParams.get('id')))),

    /**
     * Asks Hamro Pay whether this order is paid. The customer's redirect carries no
     * proof of payment, so the answer always comes from a server-to-server call.
     */
    async verify(ctx) {
      ctx.protect();
      const { id } = await ctx.body();
      const order = ctx.owned(id);
      return ctx.json(200, ctx.publicOrder(await payments.verify(order)));
    },
  };
}

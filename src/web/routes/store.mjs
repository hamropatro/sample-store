import { product } from '../../catalog.mjs';

/** Everything the storefront needs on load: the product, the environment, a CSRF token. */
export const getStore = ctx => ctx.json(200, { product, environment: ctx.config.environment, csrf: ctx.csrf() });

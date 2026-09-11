// Endpoint paths are fixed by the Hamro Pay Checkout API; only the base URLs change
// between UAT and production. See https://hamropay.com.np/checkout/developer/reference/
const UAT_API_BASE_URL = 'https://uat-payclient.hamropatro.com/';
const UAT_GATEWAY_BASE_URL = 'https://uat-checkout-pay.hamropatro.com/';
const CREATE_SESSION_PATH = 'v1/checkout/sessionId';
const GET_TRANSACTION_PATH = 'v1/checkout/transaction';
const CHECKOUT_PROCEED_PATH = 'api/checkout';

const REQUIRED = ['HAMRO_MERCHANT_ID', 'HAMRO_CLIENT_ID', 'HAMRO_API_KEY', 'HAMRO_CLIENT_SECRET'];

function endpoint(baseUrl, path, key) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error(`${key} must be a valid URL.`); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error(`${key} must be a plain HTTPS URL with no credentials or query string.`);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(path, base).href;
}

function commissionConfig(env, merchantId) {
  const merchant = env.HAMRO_PLATFORM_MERCHANT_ID?.trim();
  const percentage = env.HAMRO_COMMISSION_PERCENTAGE?.trim();
  const amount = env.HAMRO_COMMISSION_AMOUNT?.trim();
  if (!merchant) {
    if (percentage || amount) throw new Error('Set HAMRO_PLATFORM_MERCHANT_ID to use a commission, or leave the commission settings empty.');
    return undefined;
  }
  // The API accepts commissionPercentage or commissionAmount, never both.
  if (Boolean(percentage) === Boolean(amount)) throw new Error('Set exactly one of HAMRO_COMMISSION_PERCENTAGE or HAMRO_COMMISSION_AMOUNT.');
  if (merchant === merchantId) throw new Error('The platform and selling merchant IDs must be different.');
  if (percentage) {
    const value = Number(percentage);
    if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error('HAMRO_COMMISSION_PERCENTAGE must be greater than 0 and at most 100.');
    return { commissionMerchantId: merchant, commissionPercentage: value };
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('HAMRO_COMMISSION_AMOUNT must be greater than 0.');
  return { commissionMerchantId: merchant, commissionAmount: value };
}

export function getConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const appUrl = new URL(env.APP_URL || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('APP_URL must be an HTTP(S) origin without a path.');
  for (const key of REQUIRED) {
    if (!env[key]?.trim()) throw new Error(`Set ${key} in .env. Get it from the Hamro Pay merchant portal.`);
  }

  const apiBaseUrl = env.HAMRO_API_BASE_URL?.trim() || UAT_API_BASE_URL;
  const gatewayBaseUrl = env.HAMRO_GATEWAY_BASE_URL?.trim() || UAT_GATEWAY_BASE_URL;
  // Trimmed everywhere: portal copy-paste often carries a trailing newline, and an
  // untrimmed value fails as a signature mismatch that is very hard to diagnose.
  const merchantId = env.HAMRO_MERCHANT_ID.trim();
  return {
    port,
    host: env.HOST || '127.0.0.1',
    origin: appUrl.origin,
    secure: appUrl.protocol === 'https:',
    merchantId,
    clientId: env.HAMRO_CLIENT_ID.trim(),
    apiKey: env.HAMRO_API_KEY.trim(),
    clientSecret: env.HAMRO_CLIENT_SECRET.trim(),
    webhookSecret: env.HAMRO_WEBHOOK_SECRET?.trim() || '',
    apiBaseUrl,
    gatewayBaseUrl,
    sessionUrl: endpoint(apiBaseUrl, CREATE_SESSION_PATH, 'HAMRO_API_BASE_URL'),
    transactionUrl: endpoint(apiBaseUrl, GET_TRANSACTION_PATH, 'HAMRO_API_BASE_URL'),
    gatewayUrl: endpoint(gatewayBaseUrl, CHECKOUT_PROCEED_PATH, 'HAMRO_GATEWAY_BASE_URL'),
    // Anything other than the published UAT hosts is treated as real money for labelling.
    environment: apiBaseUrl === UAT_API_BASE_URL && gatewayBaseUrl === UAT_GATEWAY_BASE_URL ? 'sandbox' : 'live',
    commission: commissionConfig(env, merchantId),
  };
}

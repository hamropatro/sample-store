export function getConfig(env = process.env) {
  const mode = env.PAYMENT_MODE || 'demo';
  if (!['demo', 'sandbox'].includes(mode)) throw new Error('PAYMENT_MODE must be demo or sandbox. This sample does not enable live payments.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const appUrl = new URL(env.APP_URL || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('APP_URL must be an HTTP(S) origin without a path.');
  const config = { mode, port, host: env.HOST || '127.0.0.1', origin: appUrl.origin, secure: appUrl.protocol === 'https:', webhookSecret: env.HAMRO_WEBHOOK_SECRET || '', merchantId: env.HAMRO_MERCHANT_ID || '' };
  if (mode === 'demo') return config;
  const required = ['HAMRO_MERCHANT_ID', 'HAMRO_CLIENT_ID', 'HAMRO_API_KEY', 'HAMRO_CLIENT_SECRET', 'HAMRO_USER_SECRET', 'HAMRO_CREATE_SESSION_URL', 'HAMRO_CREATE_SESSION_METHOD', 'HAMRO_GET_TRANSACTION_URL', 'HAMRO_GET_TRANSACTION_METHOD', 'HAMRO_GATEWAY_URL'];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Set ${key} in .env before starting sandbox mode.`);
  const httpsUrl = key => { const url = new URL(env[key]); if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${key} must be an HTTPS URL.`); return url.href; };
  const method = key => { const value = env[key].toUpperCase(); if (!['POST', 'GET'].includes(value)) throw new Error(`${key} must be GET or POST, as confirmed by Hamro Pay.`); return value; };
  Object.assign(config, { clientId: env.HAMRO_CLIENT_ID, apiKey: env.HAMRO_API_KEY, clientSecret: env.HAMRO_CLIENT_SECRET, userSecret: env.HAMRO_USER_SECRET, createUrl: httpsUrl('HAMRO_CREATE_SESSION_URL'), createMethod: method('HAMRO_CREATE_SESSION_METHOD'), transactionUrl: httpsUrl('HAMRO_GET_TRANSACTION_URL'), transactionMethod: method('HAMRO_GET_TRANSACTION_METHOD'), gatewayUrl: httpsUrl('HAMRO_GATEWAY_URL') });
  // Session creation contains secrets; never put it in a GET query string.
  if (config.createMethod !== 'POST') throw new Error('This sample supports POST for Create Session. Confirm that method with Hamro Pay.');
  const platformId = env.HAMRO_PLATFORM_MERCHANT_ID?.trim();
  const commission = env.HAMRO_COMMISSION_PERCENTAGE?.trim();
  if (Boolean(platformId) !== Boolean(commission)) throw new Error('Set both platform merchant ID and commission percentage, or leave both empty.');
  if (platformId) {
    const percentage = Number(commission);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) throw new Error('Commission percentage must be greater than 0 and at most 100.');
    if (platformId === config.merchantId) throw new Error('Platform and selling merchant IDs must be different.');
    config.commission = { commissionMerchantId: platformId, commissionPercentage: percentage };
  }
  return config;
}

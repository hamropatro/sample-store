import { htmlEscape } from '../html.mjs';

const money = amount => `NPR ${Number(amount).toLocaleString('en-US')}`;

const layout = ({ title, environment, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)} — Hamro Goods</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="env-banner">
  <div class="banner-inner">
    <span>Free shipping on orders over NPR 3,000</span>
    <span class="banner-bullet">·</span>
    <span>Easy returns within 7 days</span>
  </div>
</div>
<header class="site-header">
  <div class="header-inner">
    <a href="/" class="wordmark" aria-label="Hamro Goods, home">hamro<span class="wordmark-highlight">goods.</span></a>
    <div class="header-actions">
      <a class="nav-link" href="/">Back to the store</a>
    </div>
  </div>
</header>
${body}
</body>
</html>`;

/**
 * The page that hands the customer to Hamro Pay. It renders only `checkoutFields`:
 * merchant_id, session_id, token, merchant_transaction_id and remarks. No credential
 * is ever serialized into the page.
 */
export function handoffPage(order, config) {
  const fields = Object.entries(order.checkoutFields)
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`).join('');
  const lines = order.lines.map(line =>
    `<li><span>${htmlEscape(line.name)}, size ${htmlEscape(line.size)}${line.quantity > 1 ? ` &times; ${htmlEscape(line.quantity)}` : ''}</span><span class="amount">${htmlEscape(money(line.price * line.quantity))}</span></li>`).join('');

  return layout({
    title: 'Continue to Hamro Pay',
    environment: config.environment,
    body: `<main class="panel handoff-panel">
  <div class="handoff-badge">
    <svg class="secure-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    <span>Secure Checkout · Hamro Pay</span>
  </div>
  <h1>Confirm and continue</h1>
  <p class="lede">You will be redirected to Hamro Pay's hosted portal to pay securely. Card details, bank accounts and mobile wallet pins are never stored on this store.</p>
  
  <div class="handoff-summary-card">
    <div class="handoff-summary-header">Order Summary</div>
    <ul class="summary">${lines}</ul>
    <div class="summary-total">
      <span>Total due</span>
      <strong class="amount">${htmlEscape(money(order.amount))}</strong>
    </div>
  </div>

  <form method="POST" action="${htmlEscape(config.gatewayUrl)}" enctype="application/x-www-form-urlencoded">
    ${fields}
    <button class="primary handoff-submit-btn" type="submit">
      <span>Pay ${htmlEscape(money(order.amount))} with Hamro Pay</span>
      <span aria-hidden="true">→</span>
    </button>
  </form>

  <div class="handoff-footer">
    <p class="fine">Order #${htmlEscape(order.id)} · Session expires in 10 minutes</p>
    <a class="back" href="/">← Back to the store</a>
  </div>
</main>`,
  });
}

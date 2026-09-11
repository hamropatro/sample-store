import { htmlEscape } from '../html.mjs';

const money = amount => `NPR ${Number(amount).toLocaleString('en-US')}`;

const layout = ({ title, environment, body }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(title)}</title><link rel="stylesheet" href="/style.css"></head>
<body>
<div class="env-banner${environment === 'sandbox' ? '' : ' env-live'}">${environment === 'sandbox' ? 'Sandbox — test payments only, no money moves' : 'Live payments'}</div>
<header class="site-header"><div class="header-inner"><a href="/" class="wordmark" aria-label="Hamro Goods, home">hamro<span>goods.</span></a><div class="header-actions"><a class="header-link" href="/">Back to the store</a></div></div></header>
${body}
</body></html>`;

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
    body: `<main class="panel handoff">
  <h1>Confirm and continue</h1>
  <p class="lede">Hamro Pay takes the payment on its own secure page. This store never sees your Hamro Pay credentials.</p>
  <ul class="summary">${lines}</ul>
  <div class="summary-total"><span>Total due</span><strong class="amount">${htmlEscape(money(order.amount))}</strong></div>
  <form method="POST" action="${htmlEscape(config.gatewayUrl)}" enctype="application/x-www-form-urlencoded">${fields}
    <button class="primary" type="submit">Pay ${htmlEscape(money(order.amount))} with Hamro Pay</button>
  </form>
  <p class="fine">Order ${htmlEscape(order.id)}. This checkout session expires about 10 minutes after it was created.</p>
  <a class="back" href="/">Back to the store</a>
</main>`,
  });
}

const $ = selector => document.querySelector(selector);
// Hamro Pay appends MerchantTxnId (capital M and T) to both redirect URLs.
const id = new URLSearchParams(location.search).get('MerchantTxnId');
const cameFromFailure = location.pathname === '/payment/failure';
const SETTLING = new Set(['PENDING', 'PROCESSING']);
const POLL_MS = 3000;
const MAX_POLLS = 8;
let state;
let polls = 0;
let timer;

async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not check this payment.');
  return result;
}

const COPY = {
  PAID: ['Paid', 'Payment confirmed', 'Your server checked this with Hamro Pay before confirming it. This is a sample order, so nothing ships.'],
  FAILED: ['Not paid', 'This payment did not go through', 'Nothing was charged. You can go back to the store and try the checkout again.'],
  PENDING: ['Pending', 'Payment is still pending', 'Hamro Pay has not settled this yet. This page keeps checking on its own.'],
  PROCESSING: ['Processing', 'Payment is being processed', 'Hamro Pay accepted the payment and is settling it. This page keeps checking on its own.'],
  NOT_INITIATED: ['Not started', 'No payment was started', 'Hamro Pay has no record of a payment for this order. Go back to the store to try again.'],
};
const money = amount => `NPR ${Number(amount).toLocaleString('en-US')}`;

function render(order) {
  const [badge, title, description] = COPY[order.status] || ['Unconfirmed', 'This payment is not confirmed', 'Your server has not confirmed payment, so the order is not marked paid.'];
  $('#panel').dataset.state = order.status;
  $('#status-text').textContent = badge;
  $('#title').textContent = title;
  $('#description').textContent = cameFromFailure && order.status === 'NOT_INITIATED'
    ? 'Hamro Pay sent you back without taking a payment. Nothing was charged.'
    : description;

  const lines = $('#lines');
  lines.replaceChildren(...order.lines.map(line => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${line.name}, size ${line.size}${line.quantity > 1 ? ` × ${line.quantity}` : ''}`;
    const price = document.createElement('span');
    price.className = 'amount';
    price.textContent = money(line.price * line.quantity);
    item.append(label, price);
    return item;
  }));
  lines.hidden = !order.lines.length;
  $('#total-row').hidden = false;
  $('#amount').textContent = money(order.amount);
  $('#order-id').textContent = `Order ${order.id}`;
  $('#check-again').hidden = order.status === 'PAID';
  if (order.status === 'PAID') { try { sessionStorage.removeItem('hamro-cart'); } catch {} }
  return order.status;
}

async function verify() {
  clearTimeout(timer);
  $('#error').textContent = '';
  try {
    const status = render(await api('/api/order/verify', { id }));
    // Settlement can land a moment after the customer returns, so keep looking briefly.
    if (SETTLING.has(status) && polls++ < MAX_POLLS) timer = setTimeout(verify, POLL_MS);
  } catch (error) {
    $('#error').textContent = error.message;
    $('#check-again').hidden = false;
  }
}

$('#check-again').addEventListener('click', async () => {
  const button = $('#check-again');
  button.disabled = true;
  polls = 0;
  await verify();
  button.disabled = false;
});

try {
  if (!id) throw new Error('This link has no order reference. Start a checkout from the store.');
  state = await api('/api/store');
  $('#env-banner').textContent = state.environment === 'sandbox' ? 'Sandbox — test payments only, no money moves' : 'Live payments';
  $('#env-banner').classList.toggle('env-live', state.environment !== 'sandbox');
  render(await api(`/api/order?id=${encodeURIComponent(id)}`));
  await verify();
} catch (error) {
  $('#panel').dataset.state = 'FAILED';
  $('#status-text').textContent = 'Not found';
  $('#title').textContent = 'We could not find this order';
  $('#description').textContent = error.message;
}

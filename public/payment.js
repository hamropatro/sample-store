const $ = selector => document.querySelector(selector);
const query = new URLSearchParams(location.search);
// Hamro Pay appends MerchantTxnId (capital M and T) to both redirect URLs.
const id = query.get('MerchantTxnId') || query.get('id');
const arrivedOnFailure = location.pathname === '/payment/failure';
const SETTLING = new Set(['PENDING', 'PROCESSING']);
const MAX_POLLS = 8;
let state;
let polls = 0;
let timer;

async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not check payment.');
  return result;
}

const MESSAGES = {
  PAID: ['Payment confirmed.', 'Your server verified this payment with Get Transaction. This is a sample order; no merchandise will be shipped.'],
  FAILED: ['Payment wasn’t completed.', 'Your order remains unpaid. You can return to the store and start another checkout.'],
  PENDING: ['Payment is pending.', 'Your order stays unpaid until the server confirms completion. This page keeps checking.'],
  PROCESSING: ['Payment is processing.', 'The gateway has accepted the payment but has not settled it yet. This page keeps checking.'],
  NOT_INITIATED: ['No payment was started.', 'The gateway has not recorded a payment for this order. You can return to the store and try again.'],
};

function render(order) {
  $('#total-row').hidden = false;
  $('#payment-amount').textContent = `NPR ${order.amount.toLocaleString('en-US')}`;
  $('#order-id').textContent = `Order ${order.id}`;
  $('#payment-status').textContent = order.status === 'PAID' ? 'Payment confirmed' : order.status.replaceAll('_', ' ');
  $('#payment-status').classList.toggle('paid', order.status === 'PAID');
  $('#mode-label').textContent = order.mode === 'demo' ? 'SAMPLE STORE · DEMO MODE · LOCAL GATEWAY · NO MONEY MOVES' : 'SAMPLE STORE · HAMRO PAY SANDBOX · TEST PAYMENTS ONLY';
  $('#check-again').hidden = order.status === 'PAID';
  const [title, description] = MESSAGES[order.status] || ['Payment is not confirmed.', 'Your server has not confirmed payment. Your order has not been marked paid.'];
  $('#payment-title').textContent = title;
  $('#payment-description').textContent = arrivedOnFailure && order.status !== 'PAID'
    ? 'The gateway reported that this payment did not go through. Your order has not been marked paid.'
    : description;
  if (order.status === 'PAID') { try { sessionStorage.removeItem('hamro-cart'); } catch {} }
  return order.status;
}

async function verify() {
  clearTimeout(timer);
  $('#payment-error').textContent = '';
  try {
    const status = render(await api('/api/order/verify', { id }));
    // A gateway may settle moments after the customer returns, so keep checking briefly.
    if (SETTLING.has(status) && polls++ < MAX_POLLS) timer = setTimeout(verify, 3000);
  } catch (error) {
    $('#payment-error').textContent = error.message;
    $('#check-again').hidden = false;
  }
}

$('#check-again').addEventListener('click', async () => {
  $('#check-again').disabled = true;
  polls = 0;
  await verify();
  $('#check-again').disabled = false;
});

try {
  if (!id) throw new Error('Missing order ID. Start checkout from the store.');
  state = await api('/api/store');
  render(await api(`/api/order?id=${encodeURIComponent(id)}`));
  await verify();
} catch (error) {
  $('#payment-title').textContent = 'We couldn’t find this order.';
  $('#payment-description').textContent = error.message;
  $('#payment-status').textContent = 'Not confirmed';
}

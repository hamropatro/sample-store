const $ = selector => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const id = query.get('MerchantTxnId') || query.get('id');
let state;
const isDemoCheckout = location.pathname === '/demo/checkout';
async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) } : {});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not check payment.'); return result;
}
function render(order) {
  $('#total-row').hidden = false; $('#payment-amount').textContent = `NPR ${order.amount.toLocaleString('en-US')}`;
  $('#order-id').textContent = `Order ${order.id}`;
  $('#payment-status').textContent = order.status === 'PAID' ? 'Payment confirmed' : order.status.replaceAll('_', ' ');
  $('#payment-status').classList.toggle('paid', order.status === 'PAID');
  $('#mode-label').textContent = order.mode === 'demo' ? 'SAMPLE STORE · DEMO MODE · NO MONEY MOVES' : 'SAMPLE STORE · HAMRO PAY SANDBOX · TEST PAYMENTS ONLY';
  $('#demo-actions').hidden = !isDemoCheckout || order.mode !== 'demo' || order.status === 'PAID';
  $('#check-again').hidden = isDemoCheckout || order.status === 'PAID';
  if (isDemoCheckout && order.status !== 'PAID') { $('#payment-title').textContent = 'Try the payment flow.'; $('#payment-description').textContent = 'This is a local simulator, not the real Hamro Pay payment page. Choose a test outcome below.'; return; }
  const messages = {
    PAID: ['Payment confirmed.', order.mode === 'demo' ? 'Your simulated payment succeeded. No money moved and no merchandise will be shipped.' : 'Your server verified the sandbox payment. This is a sample order; no merchandise will be shipped.'],
    FAILED: ['Payment wasn’t completed.', 'Your order remains unpaid. You can return to the store and start another checkout.'],
    PENDING: ['Payment is pending.', 'Your order remains unpaid until the server confirms completion. Check again in a moment.'],
    PROCESSING: ['Payment is processing.', 'Your order remains unpaid while the payment is being processed.'],
  };
  const [title, description] = messages[order.status] || ['Payment is not confirmed.', 'Your server has not confirmed payment. Your order has not been marked paid.'];
  $('#payment-title').textContent = title; $('#payment-description').textContent = description;
  if (order.status === 'PAID') try { sessionStorage.removeItem('hamro-cart'); } catch {}
}
async function verify() { $('#payment-error').textContent = ''; try { render(await api('/api/order/verify', { id })); } catch (error) { $('#payment-error').textContent = error.message; $('#check-again').hidden = false; } }
$('#check-again').addEventListener('click', async () => { $('#check-again').disabled = true; await verify(); $('#check-again').disabled = false; });
for (const button of document.querySelectorAll('[data-result]')) button.addEventListener('click', async () => {
  document.querySelectorAll('[data-result]').forEach(item => item.disabled = true);
  try { await api('/api/demo/complete', { id, result: button.dataset.result }); location.assign(`/payment/return?MerchantTxnId=${encodeURIComponent(id)}`); }
  catch (error) { $('#payment-error').textContent = error.message; document.querySelectorAll('[data-result]').forEach(item => item.disabled = false); }
});
try {
  if (!id) throw new Error('Missing order ID. Start checkout from the store.');
  state = await api('/api/store');
  const order = await api(`/api/order?id=${encodeURIComponent(id)}`); render(order);
  if (!isDemoCheckout) await verify();
} catch (error) { $('#payment-title').textContent = 'We couldn’t find this order.'; $('#payment-description').textContent = error.message; $('#payment-status').textContent = 'Not confirmed'; }

const $ = selector => document.querySelector(selector);
let state, cart = [], checkoutKey;
const money = amount => `NPR ${amount.toLocaleString('en-US')}`;
const message = (text, tone = 'error') => { const node = $('#store-message'); node.textContent = text; node.classList.toggle('is-ok', tone === 'ok'); node.classList.toggle('is-info', tone === 'info'); };
const checkoutMessage = (text, tone = 'error') => { const node = $('#checkout-message'); node.textContent = text; node.classList.toggle('is-info', tone === 'info'); };
function restoreCart() {
  try { const saved = JSON.parse(sessionStorage.getItem('hamro-cart') || '[]'); cart = saved.filter(item => item.sku === state.product.sku && state.product.sizes.includes(item.size) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 5); } catch { cart = []; }
}
function renderCart() {
  try { sessionStorage.setItem('hamro-cart', JSON.stringify(cart)); } catch {}
  $('#bag-count').textContent = cart.reduce((n, line) => n + line.quantity, 0);
  const container = $('#bag-items'); container.replaceChildren();
  for (const line of cart) {
    const item = document.createElement('div'); item.className = 'bag-item';
    const image = document.createElement('img'); image.src = state.product.image; image.alt = state.product.name;
    const details = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = state.product.name;
    const description = document.createElement('p'); description.textContent = `Natural · Size ${line.size} · Quantity ${line.quantity}`;
    const price = document.createElement('p'); price.textContent = money(state.product.price * line.quantity);
    const remove = document.createElement('button'); remove.className = 'remove-button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove size ${line.size} from bag`);
    remove.addEventListener('click', () => { cart = cart.filter(entry => entry.size !== line.size); checkoutKey = undefined; renderCart(); });
    details.append(title, description, price, remove); item.append(image, details); container.append(item);
  }
  if (!cart.length) { const empty = document.createElement('p'); empty.className = 'empty-bag'; empty.textContent = 'Your bag is waiting for an everyday essential. Choose a size to get started.'; container.append(empty); }
  $('#bag-summary').hidden = !cart.length;
  $('#bag-total').textContent = money(cart.reduce((sum, line) => sum + state.product.price * line.quantity, 0));
}
const thumbs = [...document.querySelectorAll('.thumb')];
thumbs.forEach((thumb, index) => thumb.addEventListener('click', () => {
  thumbs.forEach((other, i) => { other.classList.toggle('is-active', i === index); other.setAttribute('aria-pressed', String(i === index)); });
  $('#gallery-main').src = thumb.dataset.full;
  $('#gallery-main').alt = `The Everyday Tee, ${thumb.getAttribute('aria-label').toLowerCase()}`;
  $('#gallery-index').textContent = `${String(index + 1).padStart(2, '0')} / ${String(thumbs.length).padStart(2, '0')}`;
}));
$('#open-bag').addEventListener('click', () => $('#bag-dialog').showModal());
$('#close-bag').addEventListener('click', () => $('#bag-dialog').close());
$('#bag-dialog').addEventListener('click', event => { if (event.target === $('#bag-dialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close(); } });
$('#minus').addEventListener('click', () => $('#quantity').stepDown());
$('#plus').addEventListener('click', () => $('#quantity').stepUp());
$('#product-form').addEventListener('submit', event => {
  event.preventDefault(); if (!state) return;
  const size = new FormData(event.target).get('size'), quantity = Number($('#quantity').value);
  if (!state.product.sizes.includes(size) || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) return message('Choose a size and a quantity from 1 to 5.');
  const existing = cart.find(line => line.size === size);
  if ((existing?.quantity || 0) + quantity > 5) return message('This sample allows up to 5 shirts per size.');
  if (existing) existing.quantity += quantity; else cart.push({ sku: state.product.sku, size, quantity });
  checkoutKey = undefined; message('Added to your bag.', 'ok'); renderCart(); $('#bag-dialog').showModal();
});
$('#checkout').addEventListener('click', async () => {
  if (!cart.length || !state) return;
  const button = $('#checkout'); button.disabled = true; checkoutMessage('Preparing your checkout…', 'info');
  checkoutKey ||= crypto.randomUUID();
  try {
    const response = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, 'Idempotency-Key': checkoutKey }, body: JSON.stringify({ items: cart }) });
    const result = await response.json();
    if (!response.ok) { if (response.status === 409 || response.status === 502) checkoutKey = undefined; throw new Error(result.error || 'Could not start checkout.'); }
    window.location.assign(result.url);
  } catch (error) { checkoutMessage(error.message); button.disabled = false; }
});
try {
  const response = await fetch('/api/store'); if (!response.ok) throw new Error('Store unavailable.'); state = await response.json();
  const sandbox = state.environment === 'sandbox';
  $('#env-banner').textContent = sandbox ? 'Sandbox — test payments only, no money moves' : 'Live payments';
  $('#env-banner').classList.toggle('env-live', !sandbox);
  $('#bag-mode').textContent = sandbox ? 'Hamro Pay takes the payment on its own secure page. Sandbox payments move no money.' : 'Hamro Pay takes the payment on its own secure page.';
  $('#price').textContent = money(state.product.price); $('#add-to-bag').disabled = false;
  restoreCart(); renderCart();
} catch { message('Could not load the store. Make sure the Node.js server is running, then refresh.'); }

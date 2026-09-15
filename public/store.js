const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let state, cart = [], checkoutKey;
const money = amount => `NPR ${amount.toLocaleString('en-US')}`;

const message = (text, tone = 'error') => {
  const node = $('#store-message');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-ok', tone === 'ok');
  node.classList.toggle('is-info', tone === 'info');
};

const checkoutMessage = (text, tone = 'error') => {
  const node = $('#checkout-message');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-info', tone === 'info');
};

function restoreCart() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('hamro-cart') || '[]');
    cart = saved.filter(item => item.sku === state.product.sku && state.product.sizes.includes(item.size) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 5);
  } catch {
    cart = [];
  }
}

function renderCart() {
  try { sessionStorage.setItem('hamro-cart', JSON.stringify(cart)); } catch {}
  
  const count = cart.reduce((n, line) => n + line.quantity, 0);
  const badge = $('#bag-count');
  if (badge) badge.textContent = count;
  
  const container = $('#bag-items');
  if (!container) return;
  container.replaceChildren();

  for (const line of cart) {
    const item = document.createElement('div');
    item.className = 'bag-item';
    
    const image = document.createElement('img');
    image.src = state.product.image;
    image.alt = state.product.name;
    
    const details = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = state.product.name;
    
    const description = document.createElement('p');
    description.textContent = `Natural · Size ${line.size} · Quantity ${line.quantity}`;
    
    const price = document.createElement('p');
    price.textContent = money(state.product.price * line.quantity);
    
    const remove = document.createElement('button');
    remove.className = 'remove-button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove size ${line.size} from bag`);
    remove.addEventListener('click', () => {
      cart = cart.filter(entry => entry.size !== line.size);
      checkoutKey = undefined;
      renderCart();
    });

    details.append(title, description, price, remove);
    item.append(image, details);
    container.append(item);
  }

  if (!cart.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-bag';
    empty.textContent = 'Your bag is waiting for an everyday essential. Choose a size to get started.';
    container.append(empty);
  }

  const summary = $('#bag-summary');
  if (summary) summary.hidden = !cart.length;
  
  const total = $('#bag-total');
  if (total) total.textContent = money(cart.reduce((sum, line) => sum + state.product.price * line.quantity, 0));
}

// Gallery Carousel & Thumbnails
const thumbs = $$('.thumb');
let currentPhotoIndex = 0;

function setPhotoIndex(index) {
  if (!thumbs.length) return;
  currentPhotoIndex = (index + thumbs.length) % thumbs.length;
  thumbs.forEach((thumb, i) => {
    const active = i === currentPhotoIndex;
    thumb.classList.toggle('is-active', active);
    thumb.setAttribute('aria-pressed', String(active));
  });
  const mainImg = $('#gallery-main');
  if (mainImg && thumbs[currentPhotoIndex]) {
    mainImg.src = thumbs[currentPhotoIndex].dataset.full;
    mainImg.alt = `The Everyday Tee, ${thumbs[currentPhotoIndex].getAttribute('aria-label')?.toLowerCase() || 'view'}`;
  }
}

thumbs.forEach((thumb, index) => {
  thumb.addEventListener('click', () => setPhotoIndex(index));
});

$('#carousel-prev')?.addEventListener('click', () => setPhotoIndex(currentPhotoIndex - 1));
$('#carousel-next')?.addEventListener('click', () => setPhotoIndex(currentPhotoIndex + 1));
$('#thumb-next')?.addEventListener('click', () => setPhotoIndex(currentPhotoIndex + 1));

// Wishlist buttons toggle
function toggleWishlist(button) {
  button.classList.toggle('is-active');
  const active = button.classList.contains('is-active');
  const allWishlist = [$('#gallery-wishlist'), $('#wishlist-btn')].filter(Boolean);
  allWishlist.forEach(btn => btn.classList.toggle('is-active', active));
  message(active ? 'Saved to your wishlist.' : 'Removed from your wishlist.', 'info');
}

$('#gallery-wishlist')?.addEventListener('click', (e) => {
  e.preventDefault();
  toggleWishlist($('#gallery-wishlist'));
});

$('#wishlist-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  toggleWishlist($('#wishlist-btn'));
});

// Color Swatches
$$('.swatch').forEach(swatch => {
  swatch.addEventListener('click', () => {
    $$('.swatch').forEach(s => {
      s.classList.toggle('is-active', s === swatch);
      s.setAttribute('aria-checked', String(s === swatch));
    });
    const colorName = swatch.dataset.color || 'Natural';
    const label = $('#selected-color-name');
    if (label) label.textContent = colorName;
  });
});

// Size Guide Dialog
const sizeDialog = $('#size-guide-dialog');
$('#open-size-guide')?.addEventListener('click', () => sizeDialog?.showModal());
$('#footer-size-guide')?.addEventListener('click', () => sizeDialog?.showModal());
$('#close-size-guide')?.addEventListener('click', () => sizeDialog?.close());
sizeDialog?.addEventListener('click', event => {
  if (event.target === sizeDialog) {
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      event.target.close();
    }
  }
});

// Bag Dialog
const bagDialog = $('#bag-dialog');
$('#open-bag')?.addEventListener('click', () => bagDialog?.showModal());
$('#close-bag')?.addEventListener('click', () => bagDialog?.close());
bagDialog?.addEventListener('click', event => {
  if (event.target === bagDialog) {
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      event.target.close();
    }
  }
});

// Quantity Stepper
$('#minus')?.addEventListener('click', () => $('#quantity')?.stepDown());
$('#plus')?.addEventListener('click', () => $('#quantity')?.stepUp());

// Product Form Submission
$('#product-form')?.addEventListener('submit', event => {
  event.preventDefault();
  if (!state) return;
  const size = new FormData(event.target).get('size');
  const quantity = Number($('#quantity').value);

  if (!state.product.sizes.includes(size) || !Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
    return message('Choose a size and a quantity from 1 to 5.');
  }

  const existing = cart.find(line => line.size === size);
  if ((existing?.quantity || 0) + quantity > 5) {
    return message('This sample allows up to 5 shirts per size.');
  }

  if (existing) existing.quantity += quantity;
  else cart.push({ sku: state.product.sku, size, quantity });

  checkoutKey = undefined;
  message('Added to your bag.', 'ok');
  renderCart();
  bagDialog?.showModal();
});

// Checkout with Hamro Pay
$('#checkout')?.addEventListener('click', async () => {
  if (!cart.length || !state) return;
  const button = $('#checkout');
  button.disabled = true;
  checkoutMessage('Preparing your checkout…', 'info');
  checkoutKey ||= crypto.randomUUID();

  try {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': state.csrf,
        'Idempotency-Key': checkoutKey
      },
      body: JSON.stringify({ items: cart })
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409 || response.status === 502) checkoutKey = undefined;
      throw new Error(result.error || 'Could not start checkout.');
    }
    window.location.assign(result.url);
  } catch (error) {
    checkoutMessage(error.message);
    button.disabled = false;
  }
});

// Initialize Store Data
try {
  const response = await fetch('/api/store');
  if (!response.ok) throw new Error('Store unavailable.');
  state = await response.json();

  const sandbox = state.environment === 'sandbox';
  const pill = $('#env-pill');
  if (pill) {
    pill.hidden = false;
    pill.textContent = sandbox ? 'Sandbox' : 'Live';
  }
  
  const bagMode = $('#bag-mode');
  if (bagMode) {
    bagMode.textContent = sandbox 
      ? 'Hamro Pay takes the payment on its own secure page. Sandbox payments move no money.'
      : 'Hamro Pay takes the payment on its own secure page.';
  }

  const priceEl = $('#price');
  if (priceEl) priceEl.textContent = money(state.product.price);
  
  const addBtn = $('#add-to-bag');
  if (addBtn) addBtn.disabled = false;

  restoreCart();
  renderCart();
} catch {
  message('Could not load the store. Make sure the Node.js server is running, then refresh.');
}

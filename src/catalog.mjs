export const product = Object.freeze({
  sku: 'everyday-tee', name: 'The Everyday Tee',
  price: 1200, currency: 'NPR', sizes: ['S', 'M', 'L', 'XL'],
  color: 'Natural', image: '/assets/everyday-tee.png',
});

export function priceCart(items) {
  if (!Array.isArray(items) || !items.length || items.length > 4) throw new Error('Choose at least one T-shirt.');
  const sizes = new Set();
  const lines = items.map(item => {
    if (item?.sku !== product.sku || !product.sizes.includes(item.size)) throw new Error('Choose a valid product and size.');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 5 || sizes.has(item.size)) throw new Error('Choose 1–5 shirts per size.');
    sizes.add(item.size);
    // `image` travels to Hamro Pay's productList, which renders it on the hosted checkout page.
    return { sku: product.sku, name: product.name, size: item.size, quantity: item.quantity, price: product.price, image: product.image };
  });
  const amount = lines.reduce((total, line) => total + line.price * line.quantity, 0);
  return { lines, amount, currency: product.currency };
}

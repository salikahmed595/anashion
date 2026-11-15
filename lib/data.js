'use strict';
const { get, all, run, tx } = require('./db');
const { slugify, int, clean, token, ShopError } = require('./core');

// ------------------------------------------------------------------ settings

let settingsCache = null;
function settings() {
  if (!settingsCache) {
    settingsCache = {};
    for (const row of all('SELECT key, value FROM settings')) settingsCache[row.key] = row.value;
  }
  return settingsCache;
}

function saveSettings(values) {
  tx(() => {
    for (const [key, value] of Object.entries(values)) {
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
    }
  });
  settingsCache = null;
}

function shippingFor(subtotal, s = settings()) {
  const free = int(s.free_shipping_over);
  return free > 0 && subtotal >= free ? 0 : Math.max(0, int(s.shipping_fee));
}

// ------------------------------------------------------------------ catalogue

const categories = () => all('SELECT * FROM categories ORDER BY sort, id');
const category = (slug) => get('SELECT * FROM categories WHERE slug = ?', slug);
const pages = () => all('SELECT * FROM pages ORDER BY sort, id');
const page = (slug) => get('SELECT * FROM pages WHERE slug = ?', slug);

/** A slug that no other row in `table` uses ("shirt", "shirt-2", ...). */
function uniqueSlug(table, wanted, exceptId) {
  const base = slugify(wanted);
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const hit = get(`SELECT id FROM ${table} WHERE slug = ?`, slug);
    if (!hit || hit.id === exceptId) return slug;
  }
}

const PRODUCT_SELECT = `
  SELECT p.*, c.slug AS cat_slug, c.name AS cat_name, c.swatch, c.sketch,
    (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort, i.id LIMIT 1) AS image,
    (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort, i.id LIMIT 1 OFFSET 1) AS image2,
    (SELECT COALESCE(SUM(v.stock), 0) FROM variants v WHERE v.product_id = p.id) AS stock
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

const SORTS = { newest: 'p.created_at DESC, p.id DESC', 'price-asc': 'p.price ASC, p.id', 'price-desc': 'p.price DESC, p.id', name: 'p.name COLLATE NOCASE' };

function listProducts(o = {}) {
  const where = [];
  const args = [];
  if (!o.includeDrafts) where.push('p.published = 1');
  if (o.cat) { where.push('c.slug = ?'); args.push(o.cat); }
  if (o.dept) { where.push("(p.dept = ? OR p.dept = '')"); args.push(o.dept); }
  if (o.isNew) where.push('p.is_new = 1');
  if (o.exceptId) { where.push('p.id <> ?'); args.push(o.exceptId); }
  if (o.q) {
    const like = `%${String(o.q).replace(/[%_]/g, ' ').trim()}%`;
    where.push('(p.name LIKE ? OR p.description LIKE ? OR c.name LIKE ?)');
    args.push(like, like, like);
  }
  const sql = `${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${SORTS[o.sort] || SORTS.newest} LIMIT ?`;
  return all(sql, ...args, o.limit || 300);
}

function withDetails(p) {
  if (!p) return null;
  p.images = all('SELECT url FROM product_images WHERE product_id = ? ORDER BY sort, id', p.id).map((r) => r.url);
  p.variants = all('SELECT * FROM variants WHERE product_id = ? ORDER BY sort, id', p.id);
  return p;
}
const productBySlug = (slug) => withDetails(get(`${PRODUCT_SELECT} WHERE p.slug = ?`, slug));
const productById = (id) => withDetails(get(`${PRODUCT_SELECT} WHERE p.id = ?`, id));

const isImageUrl = (u) => /^\/(uploads|assets\/images)\/[\w.-]+$/.test(u);

function recordMove(variantId, delta, reason, note = '', orderId = null) {
  run('INSERT INTO stock_moves (variant_id, delta, reason, note, order_id, created_at) VALUES (?,?,?,?,?,?)',
    variantId, delta, reason, note, orderId, new Date().toISOString());
}

/**
 * Create (id = null) or update a product with its photos and sizes.
 * variants: [{ id?, size, sku, stock }] in display order; sizes left out are deleted.
 */
function saveProduct(id, f, images, variants) {
  const name = clean(f.name, 140);
  if (!name) throw new ShopError('Give the product a name.');
  const sizes = variants.filter((v) => v.size);
  if (!sizes.length) throw new ShopError('Add at least one size. Use "One size" for items without sizes.');
  if (new Set(sizes.map((v) => v.size.toLowerCase())).size !== sizes.length) throw new ShopError('Each size can only be listed once.');

  return tx(() => {
    const slug = uniqueSlug('products', f.slug || name, id);
    const row = [slug, name, clean(f.description, 6000), Math.max(0, int(f.price)), Math.max(0, int(f.compare_price)),
      f.category_id || null, ['woman', 'man'].includes(f.dept) ? f.dept : '', f.is_new ? 1 : 0, f.published ? 1 : 0];
    if (id) {
      // Saving a sample product makes it yours, so "Delete sample products" will not remove it.
      run('UPDATE products SET slug=?, name=?, description=?, price=?, compare_price=?, category_id=?, dept=?, is_new=?, published=?, is_sample=0 WHERE id=?', ...row, id);
    } else {
      id = Number(run('INSERT INTO products (slug, name, description, price, compare_price, category_id, dept, is_new, published, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ...row, new Date().toISOString()).lastInsertRowid);
    }

    run('DELETE FROM product_images WHERE product_id = ?', id);
    images.filter(isImageUrl).slice(0, 12).forEach((url, i) => run('INSERT INTO product_images (product_id, url, sort) VALUES (?,?,?)', id, url, i));

    const keep = [];
    sizes.forEach((v, i) => {
      const stock = Math.max(0, int(v.stock));
      const current = v.id ? get('SELECT * FROM variants WHERE id = ? AND product_id = ?', v.id, id) : null;
      if (current) {
        run('UPDATE variants SET size=?, sku=?, stock=?, sort=? WHERE id=?', v.size, v.sku, stock, i, current.id);
        if (stock !== current.stock) recordMove(current.id, stock - current.stock, 'correction', 'Changed on the product page');
        keep.push(current.id);
      } else {
        const vid = Number(run('INSERT INTO variants (product_id, size, sku, stock, sort) VALUES (?,?,?,?,?)', id, v.size, v.sku, stock, i).lastInsertRowid);
        if (stock > 0) recordMove(vid, stock, 'restock', 'Opening stock');
        keep.push(vid);
      }
    });
    run(`DELETE FROM variants WHERE product_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`, id, ...keep);
    return id;
  });
}

// ------------------------------------------------------------------ inventory

const REASONS = { restock: 'Restock', correction: 'Correction', damaged: 'Damaged or lost', return: 'Customer return', sale: 'Sold', cancelled: 'Order cancelled' };

function adjustStock(variantId, delta, reason, note) {
  if (!delta) throw new ShopError('Enter how many pieces to add or remove, for example 10 or -2.');
  return tx(() => {
    const v = get('SELECT * FROM variants WHERE id = ?', variantId);
    if (!v) throw new ShopError('That size no longer exists.');
    if (v.stock + delta < 0) throw new ShopError(`Only ${v.stock} in stock, so ${Math.abs(delta)} cannot be removed.`);
    run('UPDATE variants SET stock = stock + ? WHERE id = ?', delta, variantId);
    recordMove(variantId, delta, ['restock', 'correction', 'damaged', 'return'].includes(reason) ? reason : 'correction', clean(note, 200));
    return v.stock + delta;
  });
}

// ------------------------------------------------------------------ orders

const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const STATUS_LABEL = { new: 'New', confirmed: 'Confirmed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
const SOURCES = { website: 'Website', phone: 'Phone', whatsapp: 'WhatsApp', instagram: 'Instagram', store: 'In store', other: 'Other' };
const PAYMENTS = { cod: 'Cash on delivery', bank: 'Bank transfer', paid: 'Paid in store' };

function withItems(order) {
  if (!order) return null;
  order.items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  return order;
}
const orderById = (id) => withItems(get('SELECT * FROM orders WHERE id = ?', id));
const orderByNumber = (number) => withItems(get('SELECT * FROM orders WHERE number = ?', String(number)));

/** Merge repeated lines and drop bad ones: [{id, qty}] -> Map(variantId -> qty). */
function normaliseItems(items) {
  const wanted = new Map();
  for (const it of Array.isArray(items) ? items.slice(0, 60) : []) {
    const id = int(it && it.id);
    const qty = int(it && it.qty);
    if (id > 0 && qty > 0) wanted.set(id, Math.min(50, (wanted.get(id) || 0) + qty));
  }
  return wanted;
}

/** Current price, name and stock for the lines of a bag (nothing is reserved). */
function priceCart(items) {
  const s = settings();
  const lines = [];
  for (const [id, qty] of normaliseItems(items)) {
    const v = get(`SELECT v.id, v.size, v.stock, p.name, p.slug, p.price, p.published, c.swatch, c.sketch,
        (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.sort, i.id LIMIT 1) AS image
      FROM variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id WHERE v.id = ?`, id);
    if (!v || !v.published) continue;
    lines.push({ id: v.id, name: v.name, slug: v.slug, size: v.size, price: v.price, stock: v.stock, qty: Math.min(qty, v.stock), wanted: qty, image: v.image || '', swatch: v.swatch || 'linen', sketch: v.sketch || 'hanger' });
  }
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const shipping = subtotal > 0 ? shippingFor(subtotal, s) : 0;
  return { lines, subtotal, shipping, total: subtotal + shipping, freeOver: int(s.free_shipping_over) };
}

/**
 * Place an order and take its pieces out of stock in one step.
 * If any line cannot be filled, nothing is saved and a ShopError explains why.
 */
function createOrder(input) {
  const wanted = normaliseItems(input.items);
  if (!wanted.size) throw new ShopError('There is nothing in the bag.');

  const c = input.customer || {};
  const customer = {
    name: clean(c.name, 120), phone: clean(c.phone, 40), email: clean(c.email, 160).toLowerCase(),
    address: clean(c.address, 400), city: clean(c.city, 80), notes: clean(c.notes, 600),
  };
  const source = SOURCES[input.source] ? input.source : 'website';
  const payment = PAYMENTS[input.payment] ? input.payment : 'cod';
  if (customer.name.length < 2) throw new ShopError('Please enter your full name.');
  if (customer.phone.replace(/\D/g, '').length < 7) throw new ShopError('Please enter a phone number we can reach you on.');
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new ShopError('That email address does not look right.');
  if (source !== 'store' && (customer.address.length < 5 || !customer.city)) throw new ShopError('Please enter the delivery address and city.');

  return tx(() => {
    const lines = [];
    let subtotal = 0;
    for (const [id, qty] of wanted) {
      const v = get('SELECT v.*, p.name, p.price, p.published FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', id);
      if (!v || (!v.published && !input.byAdmin)) throw new ShopError('One of the items is no longer available. Please remove it and try again.');
      const taken = run('UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?', qty, id, qty);
      if (!taken.changes) {
        throw new ShopError(v.stock > 0 ? `Only ${v.stock} left of ${v.name} (${v.size}). Please lower the quantity.` : `${v.name} (${v.size}) has just sold out.`);
      }
      lines.push({ v, qty });
      subtotal += v.price * qty;
    }
    const shipping = Number.isInteger(input.shipping) && input.shipping >= 0 ? input.shipping : shippingFor(subtotal);
    const now = new Date().toISOString();
    const id = Number(run(`INSERT INTO orders (number, token, status, source, payment, name, phone, email, address, city, notes, admin_notes, subtotal, shipping, total, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `tmp-${token(8)}`, token(16), 'new', source, payment, customer.name, customer.phone, customer.email, customer.address, customer.city,
      customer.notes, clean(input.adminNotes, 1000), subtotal, shipping, subtotal + shipping, now, now).lastInsertRowid);
    const number = String(1000 + id);
    run('UPDATE orders SET number = ? WHERE id = ?', number, id);
    for (const { v, qty } of lines) {
      run('INSERT INTO order_items (order_id, product_id, variant_id, name, size, sku, price, qty) VALUES (?,?,?,?,?,?,?,?)', id, v.product_id, v.id, v.name, v.size, v.sku, v.price, qty);
      recordMove(v.id, -qty, 'sale', `Order #${number}`, id);
    }
    return orderById(id);
  });
}

/** Move an order to another status. Cancelling puts its pieces back into stock. */
function setOrderStatus(id, status) {
  if (!STATUSES.includes(status)) throw new ShopError('Unknown status.');
  return tx(() => {
    const order = orderById(id);
    if (!order) throw new ShopError('Order not found.');
    if (order.status === status) return order;
    if (order.status === 'cancelled') throw new ShopError('A cancelled order cannot be reopened, because its stock has been returned. Create a new order instead.');
    if (status === 'cancelled') {
      for (const item of order.items) {
        if (!item.variant_id) continue;
        run('UPDATE variants SET stock = stock + ? WHERE id = ?', item.qty, item.variant_id);
        recordMove(item.variant_id, item.qty, 'cancelled', `Order #${order.number}`, order.id);
      }
    }
    run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id);
    return orderById(id);
  });
}

module.exports = {
  settings, saveSettings, shippingFor, categories, category, pages, page, uniqueSlug, listProducts, productBySlug, productById,
  saveProduct, isImageUrl, REASONS, adjustStock, STATUSES, STATUS_LABEL, SOURCES, PAYMENTS, orderById, orderByNumber, priceCart, createOrder, setOrderStatus,
};

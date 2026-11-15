'use strict';
// The admin panel: orders, products, inventory, content and settings.
const fs = require('node:fs');
const path = require('node:path');
const data = require('./data');
const { get, all, run, tx, UPLOAD_DIR } = require('./db');
const { esc, money, int, clean, slugify, fmtDate, dayKey, token, hashPassword, verifyPassword, limiter, ShopError } = require('./core');
const { SWATCHES, SKETCHES } = require('./art');
const { V } = require('./shop');

const SESSION_DAYS = 14;
const loginLimit = limiter(10, 15 * 60 * 1000);

// ------------------------------------------------------------------ sign-in

function currentAdmin(ctx) {
  const sid = ctx.cookies.sid;
  if (!sid) return null;
  const row = get('SELECT a.id, a.username, s.expires FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?', sid);
  return row && row.expires > new Date().toISOString() ? row : null;
}

/** Forms may only be posted from our own pages (stops other sites acting as the admin). */
function sameOrigin(ctx) {
  const from = ctx.req.headers.origin || ctx.req.headers.referer;
  if (!from) return false;
  try {
    const host = new URL(from).host;
    return host === ctx.req.headers.host || host === ctx.req.headers['x-forwarded-host'];
  } catch { return false; }
}

const back = (ctx, to, kind, text) => ctx.redirect(`${to}${to.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`);

// ------------------------------------------------------------------ layout

const MENU = [['dashboard', '/admin', 'Dashboard'], ['orders', '/admin/orders', 'Orders'], ['products', '/admin/products', 'Products'],
  ['inventory', '/admin/inventory', 'Inventory'], ['categories', '/admin/categories', 'Categories'], ['pages', '/admin/pages', 'Pages'],
  ['subscribers', '/admin/subscribers', 'Subscribers'], ['settings', '/admin/settings', 'Settings']];

function head(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} – Store admin</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gilda+Display&family=Raleway:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/css/admin.css?v=${V}"></head>`;
}

function page(ctx, { title, active, actions = '', body }) {
  const s = data.settings();
  const ok = ctx.query.get('ok');
  const err = ctx.query.get('err');
  const fresh = get("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").n;
  ctx.html(`${head(title)}<body>
<aside class="side">
  <a class="side-brand" href="/admin">${esc(s.brand_name)}<small>Store admin</small></a>
  <nav>${MENU.map(([key, url, label]) => `<a href="${url}"${key === active ? ' class="is-on" aria-current="page"' : ''}>${label}${key === 'orders' && fresh ? `<span class="pill">${fresh}</span>` : ''}</a>`).join('')}</nav>
  <div class="side-foot"><a href="/" target="_blank" rel="noopener">View store ↗</a>
    <form method="post" action="/admin/logout"><button type="submit">Log out</button></form></div>
</aside>
<main class="main">
  <header class="top"><h1>${esc(title)}</h1><div class="actions">${actions}</div></header>
  ${ok ? `<p class="flash ok" role="status">${esc(ok)}</p>` : ''}${err ? `<p class="flash err" role="alert">${esc(err)}</p>` : ''}
  ${body}
</main>
<script src="/assets/js/admin.js?v=${V}" defer></script></body></html>`);
}

// ------------------------------------------------------------------ form helpers

const field = (label, name, value = '', o = {}) => `<div class="field${o.wide ? ' wide' : ''}"><label for="f-${name}">${label}${o.hint ? ` <small>${o.hint}</small>` : ''}</label>` +
  (o.rows ? `<textarea id="f-${name}" name="${name}" rows="${o.rows}"${o.required ? ' required' : ''}>${esc(value)}</textarea>`
    : `<input id="f-${name}" name="${name}" type="${o.type || 'text'}" value="${esc(value)}"${o.required ? ' required' : ''}${o.min != null ? ` min="${o.min}"` : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.attrs || ''}>`) + '</div>';
const check = (label, name, on) => `<label class="check"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${label}</label>`;
const select = (label, name, options, value) => `<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;

/** Photo picker: uploads go to /admin/upload and the returned URLs are posted with the form. */
function photos(name, urls, { single = false, label = 'Photos' } = {}) {
  const item = (u) => `<div class="img-item"><img src="${esc(u)}" alt=""><input type="hidden" name="${name}" value="${esc(u)}"><div class="img-actions">${single ? '' : '<button type="button" data-img-first>Make first</button>'}<button type="button" data-img-remove>Remove</button></div></div>`;
  return `<div class="field wide" data-uploader data-name="${name}"${single ? ' data-single' : ''}>
    <span class="label">${label}</span>
    <div class="img-list">${urls.filter(Boolean).map(item).join('')}</div>
    <label class="btn"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif"${single ? '' : ' multiple'} hidden data-img-input>${single ? 'Choose photo' : 'Upload photos'}</label>
    <span class="upload-note" data-upload-note></span></div>`;
}

const badge = (status) => `<span class="st st-${status}">${data.STATUS_LABEL[status] || status}</span>`;

function stockBadge(stock, low) {
  if (stock <= 0) return '<span class="st st-out">Out of stock</span>';
  if (stock <= low) return '<span class="st st-low">Low</span>';
  return '<span class="st st-ok">In stock</span>';
}

function ordersTable(orders, s) {
  if (!orders.length) return '<p class="empty">No orders here yet.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>From</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
    ${orders.map((o) => `<tr><td><a href="/admin/orders/${o.id}"><strong>#${esc(o.number)}</strong></a></td><td>${esc(fmtDate(o.created_at, s.timezone))}</td>
      <td>${esc(o.name)}<small>${esc(o.city)}</small></td><td>${esc(data.SOURCES[o.source] || o.source)}</td><td class="num">${money(o.total, s.currency)}</td><td>${badge(o.status)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ------------------------------------------------------------------ routes

module.exports = (app) => {
  const guard = (handler) => (ctx) => {
    ctx.admin = currentAdmin(ctx);
    if (!ctx.admin) return ctx.req.method === 'GET' ? ctx.redirect('/admin/login') : ctx.html('Please sign in again.', 401);
    if (ctx.req.method === 'POST' && !sameOrigin(ctx)) return ctx.html('This form was not sent from the admin panel.', 403);
    return handler(ctx);
  };
  const GET = (p, h) => app.get(p, guard(h));
  const POST = (p, h) => app.post(p, guard(h));
  /** Run a change; on a ShopError go back to `to` and show the message. */
  const attempt = (ctx, to, fn) => {
    try { return fn(); } catch (err) {
      if (!(err instanceof ShopError)) throw err;
      back(ctx, to, 'err', err.message);
      return undefined;
    }
  };

  // ---- sign-in
  const loginPage = (ctx, error = '', status = 200) => ctx.html(`${head('Sign in')}<body class="login">
    <form class="login-card" method="post" action="/admin/login">
      <h1>${esc(data.settings().brand_name)}</h1><p>Store admin</p>
      <div class="field"><label for="f-username">Username</label><input id="f-username" name="username" autocomplete="username" value="admin" required></div>
      <div class="field"><label for="f-password">Password</label><input id="f-password" name="password" type="password" autocomplete="current-password" required autofocus></div>
      ${error ? `<p class="flash err" role="alert">${esc(error)}</p>` : ''}
      <button class="btn primary" type="submit">Sign in</button>
    </form></body></html>`, status);

  app.get('/admin/login', (ctx) => (currentAdmin(ctx) ? ctx.redirect('/admin') : loginPage(ctx)));
  app.post('/admin/login', (ctx) => {
    if (!sameOrigin(ctx)) return loginPage(ctx, 'Please reload the page and try again.', 403);
    if (!loginLimit(ctx.ip)) return loginPage(ctx, 'Too many attempts. Wait 15 minutes and try again.', 429);
    const user = get('SELECT * FROM admins WHERE username = ?', clean(ctx.form.get('username'), 60));
    if (!user || !verifyPassword(ctx.form.get('password') || '', user.salt, user.pass_hash)) return loginPage(ctx, 'Wrong username or password.', 401);
    const sid = token(32);
    run('DELETE FROM sessions WHERE expires < ?', new Date().toISOString());
    run('INSERT INTO sessions (token, admin_id, expires) VALUES (?,?,?)', sid, user.id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
    ctx.setCookie('sid', sid, SESSION_DAYS * 86400);
    ctx.redirect('/admin');
  });
  POST('/admin/logout', (ctx) => {
    run('DELETE FROM sessions WHERE token = ?', ctx.cookies.sid);
    ctx.setCookie('sid', '', 0);
    ctx.redirect('/admin/login');
  });

  // ---- dashboard
  GET('/admin', (ctx) => {
    const s = data.settings();
    const low = int(s.low_stock);
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const recent = all('SELECT created_at, total, status FROM orders WHERE created_at >= ?', since);
    const today = dayKey(new Date().toISOString(), s.timezone);
    const live = recent.filter((o) => o.status !== 'cancelled');
    const todays = live.filter((o) => dayKey(o.created_at, s.timezone) === today);
    const waiting = get("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").n;
    const toShip = get("SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed'").n;
    const lowRows = all(`SELECT v.id, v.size, v.stock, p.name, p.id AS pid FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.published = 1 AND v.stock <= ? ORDER BY v.stock, p.name LIMIT 12`, low);
    const samples = get('SELECT COUNT(*) AS n FROM products WHERE is_sample = 1').n;
    const stat = (label, value, note = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="stat"><span>${label}</span><strong>${value}</strong><small>${note}</small></${href ? 'a' : 'div'}>`;
    page(ctx, { title: 'Dashboard', active: 'dashboard', actions: '<a class="btn primary" href="/admin/orders/new">Take an order</a>', body: `
      ${samples ? `<div class="notice-box"><p><strong>${samples} sample products are in the shop.</strong> Their names, prices and stock are made up so you can try everything. Remove them before you open to customers.</p>
        <form method="post" action="/admin/samples/delete" data-confirm="Delete all sample products? Orders already placed for them are kept."><button class="btn" type="submit">Delete sample products</button></form></div>` : ''}
      <div class="stats">
        ${stat('Orders today', todays.length, money(todays.reduce((a, o) => a + o.total, 0), s.currency))}
        ${stat('Waiting to be confirmed', waiting, waiting ? 'Open them and confirm' : 'All caught up', '/admin/orders?status=new')}
        ${stat('Confirmed, to ship', toShip, '', '/admin/orders?status=confirmed')}
        ${stat('Sales, last 30 days', money(live.reduce((a, o) => a + o.total, 0), s.currency), `${live.length} ${live.length === 1 ? 'order' : 'orders'}, cancelled ones left out`)}
      </div>
      <div class="cols">
        <section class="panel"><h2>Latest orders</h2>${ordersTable(all('SELECT * FROM orders ORDER BY id DESC LIMIT 8'), s)}<p><a href="/admin/orders">All orders</a></p></section>
        <section class="panel"><h2>Running low</h2>
          ${lowRows.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Size</th><th class="num">Left</th></tr></thead><tbody>
            ${lowRows.map((r) => `<tr><td><a href="/admin/products/${r.pid}">${esc(r.name)}</a></td><td>${esc(r.size)}</td><td class="num">${r.stock <= 0 ? '<span class="st st-out">0</span>' : r.stock}</td></tr>`).join('')}
            </tbody></table></div><p><a href="/admin/inventory?view=low">Open inventory</a></p>` : `<p class="empty">Every size has more than ${low} in stock.</p>`}
        </section>
      </div>` });
  });

  POST('/admin/samples/delete', (ctx) => {
    run('DELETE FROM products WHERE is_sample = 1');
    back(ctx, '/admin/products', 'ok', 'Sample products deleted.');
  });

  // ---- orders
  GET('/admin/orders', (ctx) => {
    const s = data.settings();
    const status = data.STATUSES.includes(ctx.query.get('status')) ? ctx.query.get('status') : '';
    const q = clean(ctx.query.get('q'), 60);
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').map((r) => [r.status, r.n]));
    const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (q) { where.push('(number = ? OR name LIKE ? OR phone LIKE ?)'); args.push(q.replace(/^#/, ''), `%${q}%`, `%${q}%`); }
    const orders = all(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`, ...args);
    page(ctx, { title: 'Orders', active: 'orders', actions: '<a class="btn primary" href="/admin/orders/new">Take an order</a>', body: `
      <div class="filters">
        <div class="tabs"><a href="/admin/orders"${status ? '' : ' class="is-on"'}>All <span>${totalCount}</span></a>
          ${data.STATUSES.map((st) => `<a href="/admin/orders?status=${st}"${st === status ? ' class="is-on"' : ''}>${data.STATUS_LABEL[st]} <span>${counts[st] || 0}</span></a>`).join('')}</div>
        <form class="inline" method="get">${status ? `<input type="hidden" name="status" value="${status}">` : ''}
          <input name="q" type="search" value="${esc(q)}" placeholder="Order number, name or phone" aria-label="Search orders"><button class="btn" type="submit">Search</button></form>
      </div>
      ${ordersTable(orders, s)}` });
  });

  GET('/admin/orders/new', (ctx) => {
    const s = data.settings();
    const variants = all(`SELECT v.id, v.size, v.stock, p.name, p.price FROM variants v JOIN products p ON p.id = v.product_id WHERE v.stock > 0 ORDER BY p.name COLLATE NOCASE, v.sort, v.id`);
    const options = `<option value="">Choose a product and size</option>${variants.map((v) => `<option value="${v.id}">${esc(v.name)} · ${esc(v.size)} · ${money(v.price, s.currency)} · ${v.stock} in stock</option>`).join('')}`;
    const row = `<tr><td><select name="item_id" aria-label="Product and size" required>${options}</select></td><td><input name="item_qty" type="number" min="1" max="50" value="1" aria-label="Quantity" required></td><td><button class="link" type="button" data-remove-row>Remove</button></td></tr>`;
    page(ctx, { title: 'Take an order', active: 'orders', actions: '<a class="btn" href="/admin/orders">Back to orders</a>', body: `
      <p class="lede">For orders that reach you by phone, WhatsApp, Instagram or in person. Stock is taken out as soon as you save.</p>
      ${variants.length ? `<form class="panel form-grid" method="post" action="/admin/orders/new">
        <h2 class="wide">Items</h2>
        <div class="wide table-wrap"><table data-rows><thead><tr><th>Product and size</th><th>Quantity</th><th></th></tr></thead><tbody>${row}</tbody></table></div>
        <template data-row-template>${row}</template>
        <p class="wide"><button class="btn" type="button" data-add-row>Add another item</button></p>
        <h2 class="wide">Customer</h2>
        ${field('Full name', 'name', '', { required: true })}${field('Phone number', 'phone', '', { required: true, type: 'tel' })}
        ${field('Email', 'email', '', { type: 'email', hint: 'optional' })}${field('City', 'city', '', { hint: 'not needed for in-store sales' })}
        ${field('Address', 'address', '', { rows: 2, wide: true, hint: 'not needed for in-store sales' })}
        <h2 class="wide">Order</h2>
        ${select('Order came from', 'source', Object.entries(data.SOURCES).filter(([k]) => k !== 'website'))}
        ${select('Payment', 'payment', Object.entries(data.PAYMENTS))}
        ${field('Delivery charge', 'shipping', '', { type: 'number', min: 0, hint: `leave empty to use the normal charge (${money(s.shipping_fee, s.currency)})` })}
        ${field('Note for the customer', 'notes', '', { rows: 2, wide: true, hint: 'optional' })}
        ${field('Private note', 'admin_notes', '', { rows: 2, wide: true, hint: 'only you see this' })}
        <p class="wide"><button class="btn primary" type="submit">Save order</button></p>
      </form>` : '<p class="empty">Nothing is in stock, so there is nothing to sell. Add stock under Inventory first.</p>'}` });
  });

  POST('/admin/orders/new', (ctx) => {
    const f = ctx.form;
    const ids = f.getAll('item_id');
    const qtys = f.getAll('item_qty');
    const shipping = f.get('shipping');
    const order = attempt(ctx, '/admin/orders/new', () => data.createOrder({
      items: ids.map((id, i) => ({ id, qty: qtys[i] })),
      customer: { name: f.get('name'), phone: f.get('phone'), email: f.get('email'), address: f.get('address'), city: f.get('city'), notes: f.get('notes') },
      source: f.get('source'), payment: f.get('payment'), adminNotes: f.get('admin_notes'), byAdmin: true,
      shipping: shipping && shipping.trim() !== '' ? Math.max(0, int(shipping)) : undefined,
    }));
    if (order) back(ctx, `/admin/orders/${order.id}`, 'ok', `Order #${order.number} saved and stock updated.`);
  });

  GET('/admin/orders/:id', (ctx) => {
    const s = data.settings();
    const o = data.orderById(int(ctx.params.id));
    if (!o) return back(ctx, '/admin/orders', 'err', 'That order does not exist.');
    const cancelled = o.status === 'cancelled';
    page(ctx, { title: `Order #${o.number}`, active: 'orders', actions: `<a class="btn" href="/admin/orders">Back to orders</a><button class="btn" type="button" data-print>Print</button>`, body: `
      <p class="lede">${badge(o.status)} Placed ${esc(fmtDate(o.created_at, s.timezone))} · ${esc(data.SOURCES[o.source] || o.source)} · ${esc(data.PAYMENTS[o.payment] || o.payment)}</p>
      <div class="cols">
        <section class="panel"><h2>Items</h2>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Total</th></tr></thead><tbody>
          ${o.items.map((i) => `<tr><td>${i.product_id ? `<a href="/admin/products/${i.product_id}">${esc(i.name)}</a>` : esc(i.name)}<small>Size ${esc(i.size)}</small></td><td>${esc(i.sku)}</td><td class="num">${money(i.price, s.currency)}</td><td class="num">${i.qty}</td><td class="num">${money(i.price * i.qty, s.currency)}</td></tr>`).join('')}
          </tbody><tfoot><tr><td colspan="4" class="num">Subtotal</td><td class="num">${money(o.subtotal, s.currency)}</td></tr>
          <tr><td colspan="4" class="num">Delivery</td><td class="num">${money(o.shipping, s.currency)}</td></tr>
          <tr class="total"><td colspan="4" class="num">Total</td><td class="num">${money(o.total, s.currency)}</td></tr></tfoot></table></div>
        </section>
        <section class="panel"><h2>Customer</h2>
          <p><strong>${esc(o.name)}</strong><br>${esc(o.phone)}${o.email ? `<br>${esc(o.email)}` : ''}</p>
          <p>${esc(o.address) || '<span class="muted">No address</span>'}${o.city ? `<br>${esc(o.city)}` : ''}</p>
          ${o.notes ? `<h3>Customer note</h3><p>${esc(o.notes)}</p>` : ''}
          <p class="no-print"><a href="/orders/${esc(o.number)}/${esc(o.token)}" target="_blank" rel="noopener">Customer's order page ↗</a></p>
        </section>
      </div>
      <div class="cols no-print">
        <section class="panel"><h2>Status</h2>
          ${cancelled ? '<p>This order is cancelled and its pieces are back in stock.</p>' : `
          <form class="inline" method="post" action="/admin/orders/${o.id}/status">
            <select name="status" aria-label="New status">${data.STATUSES.filter((st) => st !== 'cancelled').map((st) => `<option value="${st}"${st === o.status ? ' selected' : ''}>${data.STATUS_LABEL[st]}</option>`).join('')}</select>
            <button class="btn primary" type="submit">Update status</button></form>
          <form method="post" action="/admin/orders/${o.id}/status" data-confirm="Cancel order #${esc(o.number)}? Its pieces go back into stock and this cannot be undone.">
            <input type="hidden" name="status" value="cancelled"><button class="btn danger" type="submit">Cancel order and restock</button></form>`}
        </section>
        <section class="panel"><h2>Private note</h2>
          <form method="post" action="/admin/orders/${o.id}/note"><div class="field"><textarea name="admin_notes" rows="3" aria-label="Private note">${esc(o.admin_notes)}</textarea></div>
          <button class="btn" type="submit">Save note</button></form>
        </section>
      </div>` });
  });

  POST('/admin/orders/:id/status', (ctx) => {
    const id = int(ctx.params.id);
    const o = attempt(ctx, `/admin/orders/${id}`, () => data.setOrderStatus(id, ctx.form.get('status')));
    if (o) back(ctx, `/admin/orders/${id}`, 'ok', o.status === 'cancelled' ? 'Order cancelled and stock returned.' : `Status is now ${data.STATUS_LABEL[o.status]}.`);
  });
  POST('/admin/orders/:id/note', (ctx) => {
    const id = int(ctx.params.id);
    run('UPDATE orders SET admin_notes = ? WHERE id = ?', clean(ctx.form.get('admin_notes'), 1000), id);
    back(ctx, `/admin/orders/${id}`, 'ok', 'Note saved.');
  });

  // ---- products
  GET('/admin/products', (ctx) => {
    const s = data.settings();
    const q = clean(ctx.query.get('q'), 60);
    const products = data.listProducts({ includeDrafts: true, q, sort: 'name' });
    page(ctx, { title: 'Products', active: 'products', actions: '<a class="btn primary" href="/admin/products/new">Add product</a>', body: `
      <div class="filters"><span>${products.length} products</span>
        <form class="inline" method="get"><input name="q" type="search" value="${esc(q)}" placeholder="Search products" aria-label="Search products"><button class="btn" type="submit">Search</button></form></div>
      ${products.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Product</th><th>Category</th><th class="num">Price</th><th class="num">In stock</th><th>Shop</th></tr></thead><tbody>
        ${products.map((p) => `<tr><td class="thumb-cell">${p.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="no-photo">No photo</span>'}</td>
          <td><a href="/admin/products/${p.id}"><strong>${esc(p.name)}</strong></a>${p.is_sample ? ' <span class="st st-sample">Sample</span>' : ''}${p.is_new ? ' <span class="st st-new">New</span>' : ''}</td>
          <td>${esc(p.cat_name || '–')}${p.dept ? `<small>${p.dept === 'woman' ? 'Woman' : 'Man'}</small>` : ''}</td>
          <td class="num">${money(p.price, s.currency)}</td><td class="num">${p.stock}</td>
          <td>${p.published ? '<span class="st st-ok">Visible</span>' : '<span class="st st-draft">Hidden</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty">No products yet. Add your first one.</p>'}` });
  });

  const productForm = (ctx, p) => {
    const cats = data.categories();
    const isNew = !p.id;
    const row = (v = {}) => `<tr><td><input type="hidden" name="variant_id" value="${v.id || ''}"><input name="variant_size" value="${esc(v.size || '')}" placeholder="M, 38, One size" aria-label="Size" required></td>
      <td><input name="variant_sku" value="${esc(v.sku || '')}" aria-label="SKU"></td>
      <td><input name="variant_stock" type="number" min="0" value="${v.stock ?? 0}" aria-label="In stock"></td>
      <td><button class="link" type="button" data-remove-row>Remove</button></td></tr>`;
    page(ctx, { title: isNew ? 'Add product' : p.name, active: 'products',
      actions: `<a class="btn" href="/admin/products">Back to products</a>${isNew || !p.published ? '' : `<a class="btn" href="/products/${esc(p.slug)}" target="_blank" rel="noopener">View in shop ↗</a>`}`, body: `
      <form class="panel form-grid" method="post" action="/admin/products/${isNew ? 'new' : p.id}">
        ${field('Name', 'name', p.name, { required: true, wide: true })}
        ${field('Price', 'price', p.price || '', { type: 'number', min: 0, required: true })}
        ${field('Old price', 'compare_price', p.compare_price || '', { type: 'number', min: 0, hint: 'optional, shown crossed out' })}
        ${select('Category', 'category_id', [['', 'No category'], ...cats.map((c) => [c.id, c.name])], p.category_id)}
        ${select('For', 'dept', [['', 'Everyone'], ['woman', 'Woman'], ['man', 'Man']], p.dept)}
        ${field('Description', 'description', p.description, { rows: 5, wide: true, hint: 'blank line = new paragraph, "- " starts a list item' })}
        ${photos('image', p.images || [], { label: 'Photos <small>the first one is the main photo</small>' })}
        <div class="field wide"><span class="label">Sizes and stock</span>
          <div class="table-wrap"><table data-rows><thead><tr><th>Size</th><th>SKU <small>your own code</small></th><th>In stock</th><th></th></tr></thead>
          <tbody>${(p.variants && p.variants.length ? p.variants : [{ size: 'One size' }]).map(row).join('')}</tbody></table></div>
          <template data-row-template>${row()}</template>
          <p><button class="btn" type="button" data-add-row>Add size</button></p></div>
        <div class="field wide checks">${check('Visible in the shop', 'published', isNew ? true : p.published)}${check('Show in “New In”', 'is_new', p.is_new)}</div>
        ${isNew ? '' : field('Web address', 'slug', p.slug, { hint: `/products/${esc(p.slug)}` })}
        <p class="wide"><button class="btn primary" type="submit">Save product</button></p>
      </form>
      ${isNew ? '' : `<form class="danger-zone" method="post" action="/admin/products/${p.id}/delete" data-confirm="Delete ${esc(p.name)}? Past orders keep their record of it."><button class="btn danger" type="submit">Delete product</button></form>`}` });
  };

  GET('/admin/products/new', (ctx) => productForm(ctx, {}));
  GET('/admin/products/:id', (ctx) => {
    const p = data.productById(int(ctx.params.id));
    return p ? productForm(ctx, p) : back(ctx, '/admin/products', 'err', 'That product does not exist.');
  });

  const saveProduct = (ctx, id) => {
    const f = ctx.form;
    const sizes = f.getAll('variant_size');
    const variants = sizes.map((size, i) => ({ id: int(f.getAll('variant_id')[i]) || null, size: clean(size, 30), sku: clean(f.getAll('variant_sku')[i], 40), stock: f.getAll('variant_stock')[i] }));
    const saved = attempt(ctx, id ? `/admin/products/${id}` : '/admin/products/new', () => data.saveProduct(id, {
      name: f.get('name'), slug: f.get('slug'), description: f.get('description'), price: f.get('price'), compare_price: f.get('compare_price'),
      category_id: int(f.get('category_id')) || null, dept: f.get('dept'), is_new: f.has('is_new'), published: f.has('published'),
    }, f.getAll('image'), variants));
    if (saved) back(ctx, `/admin/products/${saved}`, 'ok', 'Product saved.');
  };
  POST('/admin/products/new', (ctx) => saveProduct(ctx, null));
  POST('/admin/products/:id', (ctx) => saveProduct(ctx, int(ctx.params.id)));
  POST('/admin/products/:id/delete', (ctx) => {
    run('DELETE FROM products WHERE id = ?', int(ctx.params.id));
    back(ctx, '/admin/products', 'ok', 'Product deleted.');
  });

  // ---- photo upload (raw image body)
  const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const looksLike = {
    jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    webp: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
    gif: (b) => b.toString('latin1', 0, 4) === 'GIF8',
  };
  POST('/admin/upload', (ctx) => {
    const ext = IMAGE_EXT[String(ctx.req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext || !ctx.raw || ctx.raw.length < 16 || !looksLike[ext](ctx.raw)) return ctx.sendJson({ error: 'Please upload a JPG, PNG, WebP or GIF photo.' }, 400);
    const name = `${token(10)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), ctx.raw);
    ctx.sendJson({ url: `/uploads/${name}` });
  });

  // ---- inventory
  GET('/admin/inventory', (ctx) => {
    const s = data.settings();
    const low = int(s.low_stock);
    const view = ['low', 'out'].includes(ctx.query.get('view')) ? ctx.query.get('view') : 'all';
    const q = clean(ctx.query.get('q'), 60).toLowerCase();
    const rows = all(`SELECT v.*, p.name, p.price, p.published, p.id AS pid FROM variants v JOIN products p ON p.id = v.product_id ORDER BY p.name COLLATE NOCASE, v.sort, v.id`);
    const count = { all: rows.length, low: rows.filter((r) => r.stock > 0 && r.stock <= low).length, out: rows.filter((r) => r.stock <= 0).length };
    const shown = rows.filter((r) => (view === 'low' ? r.stock > 0 && r.stock <= low : view === 'out' ? r.stock <= 0 : true))
      .filter((r) => !q || `${r.name} ${r.size} ${r.sku}`.toLowerCase().includes(q));
    const here = `/admin/inventory?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
    const reasons = ['restock', 'correction', 'damaged', 'return'].map((r) => `<option value="${r}">${data.REASONS[r]}</option>`).join('');
    page(ctx, { title: 'Inventory', active: 'inventory', actions: '<a class="btn" href="/admin/inventory/history">Stock history</a>', body: `
      <div class="stats">
        <div class="stat"><span>Pieces in stock</span><strong>${rows.reduce((a, r) => a + r.stock, 0)}</strong><small>across ${rows.length} sizes</small></div>
        <div class="stat"><span>Stock value at shop prices</span><strong>${money(rows.reduce((a, r) => a + r.stock * r.price, 0), s.currency)}</strong><small></small></div>
        <a class="stat" href="/admin/inventory?view=low"><span>Low (${low} or fewer)</span><strong>${count.low}</strong><small>sizes</small></a>
        <a class="stat" href="/admin/inventory?view=out"><span>Out of stock</span><strong>${count.out}</strong><small>sizes</small></a>
      </div>
      <div class="filters">
        <div class="tabs">${[['all', 'All'], ['low', 'Low'], ['out', 'Out of stock']].map(([k, l]) => `<a href="/admin/inventory?view=${k}"${k === view ? ' class="is-on"' : ''}>${l} <span>${count[k]}</span></a>`).join('')}</div>
        <form class="inline" method="get"><input type="hidden" name="view" value="${view}"><input name="q" type="search" value="${esc(q)}" placeholder="Product, size or SKU" aria-label="Search inventory"><button class="btn" type="submit">Search</button></form>
      </div>
      ${shown.length ? `<div class="table-wrap"><table class="inventory"><thead><tr><th>Product</th><th>Size</th><th>SKU</th><th class="num">In stock</th><th></th><th>Add or remove pieces</th></tr></thead><tbody>
        ${shown.map((r) => `<tr><td><a href="/admin/products/${r.pid}">${esc(r.name)}</a>${r.published ? '' : ' <span class="st st-draft">Hidden</span>'}</td><td>${esc(r.size)}</td><td>${esc(r.sku)}</td>
          <td class="num"><strong>${r.stock}</strong></td><td>${stockBadge(r.stock, low)}</td>
          <td><form class="inline adjust" method="post" action="/admin/inventory/${r.id}"><input type="hidden" name="back" value="${esc(here)}">
            <input name="delta" type="number" placeholder="+10 or -2" aria-label="Pieces to add or remove for ${esc(r.name)} ${esc(r.size)}" required>
            <select name="reason" aria-label="Reason">${reasons}</select><input name="note" placeholder="Note (optional)" aria-label="Note">
            <button class="btn" type="submit">Apply</button> <a class="link" href="/admin/inventory/history?variant=${r.id}">History</a></form></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty">Nothing matches this view.</p>'}` });
  });

  POST('/admin/inventory/:id', (ctx) => {
    const to = /^\/admin\/inventory(\?|$)/.test(ctx.form.get('back') || '') ? ctx.form.get('back') : '/admin/inventory';
    const left = attempt(ctx, to, () => data.adjustStock(int(ctx.params.id), int(ctx.form.get('delta')), ctx.form.get('reason'), ctx.form.get('note')));
    if (left !== undefined) back(ctx, to, 'ok', `Stock updated. ${left} now in stock.`);
  });

  GET('/admin/inventory/history', (ctx) => {
    const s = data.settings();
    const variant = int(ctx.query.get('variant'));
    const moves = all(`SELECT m.*, v.size, p.name, p.id AS pid, o.number FROM stock_moves m JOIN variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
      LEFT JOIN orders o ON o.id = m.order_id ${variant ? 'WHERE m.variant_id = ?' : ''} ORDER BY m.id DESC LIMIT 300`, ...(variant ? [variant] : []));
    page(ctx, { title: 'Stock history', active: 'inventory', actions: '<a class="btn" href="/admin/inventory">Back to inventory</a>', body: `
      <p class="lede">Every change to a stock number, newest first${variant ? ', for one size. <a href="/admin/inventory/history">Show all</a>' : ''}.</p>
      ${moves.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Product</th><th>Size</th><th class="num">Change</th><th>Reason</th><th>Note</th></tr></thead><tbody>
        ${moves.map((m) => `<tr><td>${esc(fmtDate(m.created_at, s.timezone))}</td><td><a href="/admin/products/${m.pid}">${esc(m.name)}</a></td><td>${esc(m.size)}</td>
          <td class="num ${m.delta > 0 ? 'plus' : 'minus'}">${m.delta > 0 ? '+' : ''}${m.delta}</td><td>${esc(data.REASONS[m.reason] || m.reason)}</td>
          <td>${m.order_id ? `<a href="/admin/orders/${m.order_id}">Order #${esc(m.number)}</a>` : esc(m.note)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty">No stock changes recorded yet.</p>'}` });
  });

  // ---- categories
  GET('/admin/categories', (ctx) => {
    const cats = all('SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS n FROM categories c ORDER BY c.sort, c.id');
    page(ctx, { title: 'Categories', active: 'categories', actions: '<a class="btn primary" href="/admin/categories/new">Add category</a>', body: `
      <p class="lede">Categories make up the shop menu and the tiles on the home page.</p>
      <div class="table-wrap"><table><thead><tr><th></th><th>Category</th><th>For</th><th class="num">Products</th><th>Home page tile</th><th>Own menu link</th><th class="num">Order</th></tr></thead><tbody>
      ${cats.map((c) => `<tr><td class="thumb-cell">${c.image ? `<img src="${esc(c.image)}" alt="">` : '<span class="no-photo">No photo</span>'}</td>
        <td><a href="/admin/categories/${c.id}"><strong>${esc(c.name)}</strong></a><small>/collections/${esc(c.slug)}</small></td>
        <td>${c.depts.split(',').filter(Boolean).map((d) => (d === 'woman' ? 'Woman' : 'Man')).join(' and ') || 'Everyone'}</td>
        <td class="num">${c.n}</td><td>${c.show_home ? 'Yes' : 'No'}</td><td>${c.in_nav ? 'Yes' : 'No'}</td><td class="num">${c.sort}</td></tr>`).join('')}
      </tbody></table></div>` });
  });

  const categoryForm = (ctx, c) => {
    const isNew = !c.id;
    const depts = (c.depts || '').split(',');
    page(ctx, { title: isNew ? 'Add category' : c.name, active: 'categories', actions: '<a class="btn" href="/admin/categories">Back to categories</a>', body: `
      <form class="panel form-grid" method="post" action="/admin/categories/${isNew ? 'new' : c.id}">
        ${field('Name', 'name', c.name, { required: true })}
        ${field('Position', 'sort', c.sort ?? 0, { type: 'number', hint: 'lower numbers come first' })}
        <div class="field wide checks"><span class="label">Listed in the menu under</span>${check('Woman', 'dept_woman', depts.includes('woman'))}${check('Man', 'dept_man', depts.includes('man'))}</div>
        <div class="field wide checks">${check('Show a tile on the home page', 'show_home', isNew ? true : c.show_home)}${check('Give it its own link in the top menu', 'in_nav', c.in_nav)}</div>
        ${photos('image', [c.image], { single: true, label: 'Tile photo' })}
        ${photos('image2', [c.image2], { single: true, label: 'Second photo <small>shown when the tile is hovered</small>' })}
        ${select('Fabric shown when there is no photo', 'swatch', Object.entries(SWATCHES), c.swatch)}
        ${select('Sketch shown when there is no photo', 'sketch', Object.keys(SKETCHES).map((k) => [k, k[0].toUpperCase() + k.slice(1)]), c.sketch)}
        ${isNew ? '' : field('Web address', 'slug', c.slug, { hint: `/collections/${esc(c.slug)}` })}
        <p class="wide"><button class="btn primary" type="submit">Save category</button></p>
      </form>
      ${isNew ? '' : `<form class="danger-zone" method="post" action="/admin/categories/${c.id}/delete" data-confirm="Delete ${esc(c.name)}? Its products are kept but lose their category."><button class="btn danger" type="submit">Delete category</button></form>`}` });
  };
  GET('/admin/categories/new', (ctx) => categoryForm(ctx, {}));
  GET('/admin/categories/:id', (ctx) => {
    const c = get('SELECT * FROM categories WHERE id = ?', int(ctx.params.id));
    return c ? categoryForm(ctx, c) : back(ctx, '/admin/categories', 'err', 'That category does not exist.');
  });
  const RESERVED = ['all', 'new-in', 'woman', 'man'];
  const saveCategory = (ctx, id) => {
    const f = ctx.form;
    const name = clean(f.get('name'), 60);
    if (!name) return back(ctx, id ? `/admin/categories/${id}` : '/admin/categories/new', 'err', 'Give the category a name.');
    let wanted = slugify(f.get('slug') || name);
    if (RESERVED.includes(wanted)) wanted += '-collection';
    const img = (k) => (data.isImageUrl(f.get(k) || '') ? f.get(k) : '');
    const row = [data.uniqueSlug('categories', wanted, id), name, ['woman', 'man'].filter((d) => f.has(`dept_${d}`)).join(','), f.has('show_home') ? 1 : 0, f.has('in_nav') ? 1 : 0,
      int(f.get('sort')), SWATCHES[f.get('swatch')] ? f.get('swatch') : 'linen', SKETCHES[f.get('sketch')] ? f.get('sketch') : 'hanger', img('image'), img('image2')];
    if (id) run('UPDATE categories SET slug=?, name=?, depts=?, show_home=?, in_nav=?, sort=?, swatch=?, sketch=?, image=?, image2=? WHERE id=?', ...row, id);
    else id = Number(run('INSERT INTO categories (slug, name, depts, show_home, in_nav, sort, swatch, sketch, image, image2) VALUES (?,?,?,?,?,?,?,?,?,?)', ...row).lastInsertRowid);
    back(ctx, `/admin/categories/${id}`, 'ok', 'Category saved.');
  };
  POST('/admin/categories/new', (ctx) => saveCategory(ctx, null));
  POST('/admin/categories/:id', (ctx) => saveCategory(ctx, int(ctx.params.id)));
  POST('/admin/categories/:id/delete', (ctx) => {
    run('DELETE FROM categories WHERE id = ?', int(ctx.params.id));
    back(ctx, '/admin/categories', 'ok', 'Category deleted.');
  });

  // ---- pages
  GET('/admin/pages', (ctx) => {
    page(ctx, { title: 'Pages', active: 'pages', actions: '<a class="btn primary" href="/admin/pages/new">Add page</a>', body: `
      <p class="lede">Information pages such as About Us and your policies. Pages marked “in footer” are linked at the bottom of the shop.</p>
      <div class="table-wrap"><table><thead><tr><th>Page</th><th>Web address</th><th>In footer</th></tr></thead><tbody>
      ${data.pages().map((p) => `<tr><td><a href="/admin/pages/${p.id}"><strong>${esc(p.title)}</strong></a></td><td><a href="/pages/${esc(p.slug)}" target="_blank" rel="noopener">/pages/${esc(p.slug)} ↗</a></td><td>${p.in_footer ? 'Yes' : 'No'}</td></tr>`).join('')}
      </tbody></table></div>` });
  });
  const pageForm = (ctx, p) => {
    const isNew = !p.id;
    page(ctx, { title: isNew ? 'Add page' : p.title, active: 'pages', actions: '<a class="btn" href="/admin/pages">Back to pages</a>', body: `
      <form class="panel form-grid" method="post" action="/admin/pages/${isNew ? 'new' : p.id}">
        ${field('Title', 'title', p.title, { required: true })}${field('Position', 'sort', p.sort ?? 0, { type: 'number', hint: 'lower numbers come first' })}
        ${field('Text', 'body', p.body, { rows: 16, wide: true, hint: 'blank line = new paragraph · "## " starts a heading · "- " starts a list item · **bold**' })}
        <div class="field wide checks">${check('Link this page in the footer', 'in_footer', isNew ? true : p.in_footer)}</div>
        ${isNew ? '' : field('Web address', 'slug', p.slug, { hint: `/pages/${esc(p.slug)}` })}
        <p class="wide"><button class="btn primary" type="submit">Save page</button></p>
      </form>
      ${isNew ? '' : `<form class="danger-zone" method="post" action="/admin/pages/${p.id}/delete" data-confirm="Delete the page ${esc(p.title)}?"><button class="btn danger" type="submit">Delete page</button></form>`}` });
  };
  GET('/admin/pages/new', (ctx) => pageForm(ctx, {}));
  GET('/admin/pages/:id', (ctx) => {
    const p = get('SELECT * FROM pages WHERE id = ?', int(ctx.params.id));
    return p ? pageForm(ctx, p) : back(ctx, '/admin/pages', 'err', 'That page does not exist.');
  });
  const savePage = (ctx, id) => {
    const f = ctx.form;
    const title = clean(f.get('title'), 120);
    if (!title) return back(ctx, id ? `/admin/pages/${id}` : '/admin/pages/new', 'err', 'Give the page a title.');
    const row = [data.uniqueSlug('pages', f.get('slug') || title, id), title, clean(f.get('body'), 40000), f.has('in_footer') ? 1 : 0, int(f.get('sort'))];
    if (id) run('UPDATE pages SET slug=?, title=?, body=?, in_footer=?, sort=? WHERE id=?', ...row, id);
    else id = Number(run('INSERT INTO pages (slug, title, body, in_footer, sort) VALUES (?,?,?,?,?)', ...row).lastInsertRowid);
    back(ctx, `/admin/pages/${id}`, 'ok', 'Page saved.');
  };
  POST('/admin/pages/new', (ctx) => savePage(ctx, null));
  POST('/admin/pages/:id', (ctx) => savePage(ctx, int(ctx.params.id)));
  POST('/admin/pages/:id/delete', (ctx) => {
    run('DELETE FROM pages WHERE id = ?', int(ctx.params.id));
    back(ctx, '/admin/pages', 'ok', 'Page deleted.');
  });

  // ---- subscribers
  GET('/admin/subscribers', (ctx) => {
    const s = data.settings();
    const subs = all('SELECT * FROM subscribers ORDER BY id DESC LIMIT 2000');
    page(ctx, { title: 'Subscribers', active: 'subscribers', actions: subs.length ? '<a class="btn" href="/admin/subscribers.csv">Download as spreadsheet</a>' : '', body: `
      <p class="lede">People who signed up through “Join the list” at the bottom of the shop.</p>
      ${subs.length ? `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Signed up</th></tr></thead><tbody>
        ${subs.map((x) => `<tr><td>${esc(x.email)}</td><td>${esc(fmtDate(x.created_at, s.timezone))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nobody has signed up yet.</p>'}` });
  });
  GET('/admin/subscribers.csv', (ctx) => {
    const safe = (v) => `"${String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const csv = ['email,signed_up', ...all('SELECT * FROM subscribers ORDER BY id').map((x) => `${safe(x.email)},${safe(x.created_at)}`)].join('\r\n');
    ctx.send(200, 'text/csv; charset=utf-8', csv, { 'Content-Disposition': 'attachment; filename="subscribers.csv"' });
  });

  // ---- settings
  const TEXT_KEYS = ['brand_name', 'notice_text', 'hero_line1', 'hero_line2', 'hero_link1_label', 'hero_link1_url', 'hero_link2_label', 'hero_link2_url',
    'contact_email', 'contact_phone', 'contact_hours', 'contact_days', 'instagram_url', 'facebook_url', 'currency', 'timezone', 'meta_description'];
  GET('/admin/settings', (ctx) => {
    const s = data.settings();
    page(ctx, { title: 'Settings', active: 'settings', body: `
      <form class="panel form-grid" method="post" action="/admin/settings">
        <h2 class="wide">Brand</h2>
        ${field('Brand name', 'brand_name', s.brand_name, { required: true, hint: 'shown as the logo, in the browser tab and in the footer' })}
        ${field('Bar at the very top', 'notice_text', s.notice_text, { hint: 'leave empty to hide it' })}
        ${field('Short description for search engines', 'meta_description', s.meta_description, { wide: true })}
        <h2 class="wide">Home page banner</h2>
        ${field('Headline, first line', 'hero_line1', s.hero_line1)}${field('Headline, second line', 'hero_line2', s.hero_line2)}
        ${field('First button text', 'hero_link1_label', s.hero_link1_label)}${field('First button goes to', 'hero_link1_url', s.hero_link1_url, { hint: 'for example /collections/man' })}
        ${field('Second button text', 'hero_link2_label', s.hero_link2_label)}${field('Second button goes to', 'hero_link2_url', s.hero_link2_url)}
        ${photos('hero_image', [s.hero_image], { single: true, label: 'Banner photo <small>wide photos work best</small>' })}
        <h2 class="wide">Contact details in the footer</h2>
        ${field('Email', 'contact_email', s.contact_email)}${field('Phone', 'contact_phone', s.contact_phone)}
        ${field('Opening hours', 'contact_hours', s.contact_hours)}${field('Days', 'contact_days', s.contact_days)}
        ${field('Locations', 'locations', s.locations, { rows: 3, wide: true, hint: 'one line per row; leave empty to hide' })}
        ${field('Instagram link', 'instagram_url', s.instagram_url, { hint: 'starts with https://' })}${field('Facebook link', 'facebook_url', s.facebook_url, { hint: 'starts with https://' })}
        <h2 class="wide">Delivery and payment</h2>
        ${field('Currency symbol', 'currency', s.currency)}
        ${field('Delivery charge', 'shipping_fee', s.shipping_fee, { type: 'number', min: 0 })}
        ${field('Free delivery on orders of at least', 'free_shipping_over', s.free_shipping_over, { type: 'number', min: 0, hint: '0 = never free' })}
        ${field('Bank account details', 'bank_details', s.bank_details, { rows: 3, wide: true, hint: 'fill this in to offer bank transfer at checkout; leave empty for cash on delivery only' })}
        <h2 class="wide">Stock and time</h2>
        ${field('Warn when a size has this many or fewer', 'low_stock', s.low_stock, { type: 'number', min: 0 })}
        ${field('Time zone', 'timezone', s.timezone, { hint: 'for example Asia/Karachi' })}
        <p class="wide"><button class="btn primary" type="submit">Save settings</button></p>
      </form>
      <form class="panel form-grid" method="post" action="/admin/password">
        <h2 class="wide">Change password</h2>
        ${field('Current password', 'current', '', { type: 'password', required: true, attrs: ' autocomplete="current-password"' })}
        ${field('New password', 'next', '', { type: 'password', required: true, hint: 'at least 8 characters', attrs: ' autocomplete="new-password" minlength="8"' })}
        <p class="wide"><button class="btn" type="submit">Change password</button></p>
      </form>` });
  });
  POST('/admin/settings', (ctx) => {
    const f = ctx.form;
    const values = {};
    for (const key of TEXT_KEYS) values[key] = clean(f.get(key), 300);
    if (!values.brand_name) return back(ctx, '/admin/settings', 'err', 'The brand name cannot be empty.');
    try { new Intl.DateTimeFormat('en', { timeZone: values.timezone }); } catch { return back(ctx, '/admin/settings', 'err', 'That time zone is not recognised. Use a name like Asia/Karachi.'); }
    if (!values.currency) values.currency = 'Rs.';
    values.locations = clean(f.get('locations'), 600);
    values.bank_details = clean(f.get('bank_details'), 800);
    values.hero_image = data.isImageUrl(f.get('hero_image') || '') ? f.get('hero_image') : '';
    for (const key of ['shipping_fee', 'free_shipping_over', 'low_stock']) values[key] = Math.max(0, int(f.get(key)));
    data.saveSettings(values);
    back(ctx, '/admin/settings', 'ok', 'Settings saved.');
  });
  POST('/admin/password', (ctx) => {
    const me = get('SELECT * FROM admins WHERE id = ?', ctx.admin.id);
    const next = ctx.form.get('next') || '';
    if (!verifyPassword(ctx.form.get('current') || '', me.salt, me.pass_hash)) return back(ctx, '/admin/settings', 'err', 'The current password is wrong.');
    if (next.length < 8) return back(ctx, '/admin/settings', 'err', 'The new password needs at least 8 characters.');
    const { salt, hash } = hashPassword(next);
    tx(() => {
      run('UPDATE admins SET pass_hash = ?, salt = ? WHERE id = ?', hash, salt, me.id);
      run('DELETE FROM sessions WHERE admin_id = ? AND token <> ?', me.id, ctx.cookies.sid);
    });
    back(ctx, '/admin/settings', 'ok', 'Password changed.');
  });
};

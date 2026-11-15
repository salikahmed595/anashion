'use strict';
// End-to-end check: starts the app on a throwaway database and walks through
// browsing, ordering, stock changes and the admin panel.  Run with: npm test
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ADMIN_PASSWORD: 'test-password-1' }, stdio: ['ignore', 'pipe', 'inherit'],
});

let cookie = '';
const page = async (url, opts = {}) => {
  const res = await fetch(BASE + url, { redirect: 'manual', ...opts, headers: { Origin: BASE, Cookie: cookie, ...(opts.headers || {}) } });
  return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.get('set-cookie'), text: await res.text() };
};
const postJson = async (url, body) => {
  const r = await page(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...r, data: JSON.parse(r.text) };
};
const postForm = (url, fields) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
  return page(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
};
const stockOf = async (variantId) => (await postJson('/api/cart', { items: [{ id: variantId, qty: 1 }] })).data.lines[0].stock;
const customer = { name: 'Test Customer', phone: '0300 1234567', email: '', address: '12 Example Street', city: 'Lahore', notes: '' };

async function run() {
  // --- shop pages
  for (const url of ['/', '/collections/all', '/collections/jackets', '/collections/woman', '/collections/new-in?dept=man', '/collections/tops?sort=price-asc',
    '/products/bomber-jacket', '/pages/about', '/pages/faq', '/search?q=jacket', '/cart', '/checkout', '/track', '/assets/css/site.css', '/assets/images/jackets-front.webp']) {
    assert.equal((await page(url)).status, 200, url);
  }
  assert.equal((await page('/collections/nope')).status, 404);
  assert.equal((await page('/products/nope')).status, 404);
  assert.equal((await page('/assets/../server.js')).status, 404);
  assert.match((await page('/search?q=<script>alert(1)</script>')).text, /&lt;script&gt;/);
  assert.match((await page('/collections/jackets')).text, /Bomber Jacket/);

  // --- ordering takes stock; over-ordering is refused and takes nothing
  const product = (await page('/products/bomber-jacket')).text;
  const variant = Number(/name="variant" value="(\d+)" data-stock="4"/.exec(product)[1]);
  const cart = await postJson('/api/cart', { items: [{ id: variant, qty: 2 }] });
  assert.equal(cart.data.subtotal, 29000);
  assert.equal(cart.data.shipping, 0, 'free delivery above the threshold');

  assert.equal((await postJson('/api/orders', { items: [{ id: variant, qty: 2 }], customer: { ...customer, phone: '1' } })).status, 400);
  assert.equal((await postJson('/api/orders', { items: [{ id: variant, qty: 2 }], customer, website: 'spam' })).status, 400);
  assert.equal(await stockOf(variant), 4);

  const placed = await postJson('/api/orders', { items: [{ id: variant, qty: 2 }], customer, payment: 'cod' });
  assert.equal(placed.status, 200, placed.text);
  assert.equal(await stockOf(variant), 2);
  const orderPage = await page(placed.data.url);
  assert.equal(orderPage.status, 200);
  assert.match(orderPage.text, /Order #1001/);
  assert.equal((await page('/orders/1001/wrong-token')).status, 404);

  const tooMany = await postJson('/api/orders', { items: [{ id: variant, qty: 3 }], customer });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error, /Only 2 left/);
  assert.equal(await stockOf(variant), 2);

  const tracked = await postForm('/track', { number: '1001', phone: '03001234567' });
  assert.equal(tracked.status, 303);
  assert.equal(tracked.location, placed.data.url);
  assert.equal((await postForm('/track', { number: '1001', phone: '03009999999' })).status, 404);

  assert.equal((await postJson('/api/subscribe', { email: 'someone@example.com' })).status, 200);
  assert.equal((await postJson('/api/subscribe', { email: 'nope' })).status, 400);

  // --- admin needs a sign-in
  assert.equal((await page('/admin')).status, 303);
  assert.equal((await postForm('/admin/login', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await postForm('/admin/login', { username: 'admin', password: 'test-password-1' });
  assert.equal(login.status, 303);
  cookie = login.setCookie.split(';')[0];
  for (const url of ['/admin', '/admin/orders', '/admin/orders/1', '/admin/orders/new', '/admin/products', '/admin/products/new', '/admin/products/1',
    '/admin/inventory', '/admin/inventory?view=low', '/admin/inventory/history', '/admin/categories', '/admin/categories/1', '/admin/categories/new',
    '/admin/pages', '/admin/pages/1', '/admin/pages/new', '/admin/subscribers', '/admin/subscribers.csv', '/admin/settings']) {
    const r = await page(url);
    assert.equal(r.status, 200, url);
  }
  // forms posted from another site are refused
  assert.equal((await page('/admin/settings', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'brand_name=x' })).status, 403);

  // --- inventory: restock, then refuse to go below zero
  assert.equal((await postForm(`/admin/inventory/${variant}`, { delta: '10', reason: 'restock', note: 'New delivery' })).status, 303);
  assert.equal(await stockOf(variant), 12);
  const below = await postForm(`/admin/inventory/${variant}`, { delta: '-50', reason: 'damaged', note: '' });
  assert.match(decodeURIComponent(below.location), /err=Only 12 in stock/);
  assert.equal(await stockOf(variant), 12);

  // --- order status; cancelling returns the pieces
  await postForm('/admin/orders/1/status', { status: 'confirmed' });
  assert.match((await page(placed.data.url)).text, /class="done current">Confirmed/);
  await postForm('/admin/orders/1/status', { status: 'cancelled' });
  assert.equal(await stockOf(variant), 14);
  const reopen = await postForm('/admin/orders/1/status', { status: 'new' });
  assert.match(decodeURIComponent(reopen.location), /err=A cancelled order cannot be reopened/);
  assert.match((await page(`/admin/inventory/history?variant=${variant}`)).text, /Order cancelled/);

  // --- phone order taken in the admin
  const manual = await postForm('/admin/orders/new', { item_id: [String(variant)], item_qty: ['1'], name: 'Walk-in Customer', phone: '0300 7654321', email: '', city: '', address: '',
    source: 'store', payment: 'paid', shipping: '0', notes: '', admin_notes: 'Paid at the till' });
  assert.match(decodeURIComponent(manual.location), /Order #1002 saved/);
  assert.equal(await stockOf(variant), 13);

  // --- photo upload, then a new product with two sizes
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await page('/admin/upload', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 200, up.text);
  const photo = JSON.parse(up.text).url;
  assert.equal((await page(photo)).status, 200);
  assert.equal((await page('/admin/upload', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('<script>alert(1)</script>....') })).status, 400);

  const created = await postForm('/admin/products/new', { name: 'Test Silk Scarf', price: '3,500', compare_price: '', category_id: '8', dept: '', description: 'Line one\n\n- soft\n- light',
    image: [photo], variant_id: ['', ''], variant_size: ['Small', 'Large'], variant_sku: ['TS-S', 'TS-L'], variant_stock: ['3', '0'], published: '1', is_new: '1' });
  assert.equal(created.status, 303);
  const newId = /\/admin\/products\/(\d+)/.exec(created.location)[1];
  const live = await page('/products/test-silk-scarf');
  assert.equal(live.status, 200);
  assert.match(live.text, /Rs\. 3,500/);
  assert.match(live.text, /<li>soft<\/li>/);
  assert.match((await page('/collections/new-in')).text, /Test Silk Scarf/);
  // hide it again
  const editPage = (await page(`/admin/products/${newId}`)).text;
  const ids = [...editPage.matchAll(/name="variant_id" value="(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  await postForm(`/admin/products/${newId}`, { name: 'Test Silk Scarf', price: '3500', category_id: '8', dept: '', description: '', image: [photo], slug: 'test-silk-scarf',
    variant_id: [ids[0]], variant_size: ['Small'], variant_sku: ['TS-S'], variant_stock: ['5'] });
  assert.equal((await page('/products/test-silk-scarf')).status, 404, 'hidden products are not public');
  assert.doesNotMatch((await page(`/admin/products/${newId}`)).text, /value="Large"/);

  // --- content: settings, a page and a category show up in the shop
  await postForm('/admin/settings', { brand_name: 'Maison Test', notice_text: 'Hello & welcome', hero_line1: 'Line <one>', hero_line2: 'two', timezone: 'Asia/Karachi', currency: 'Rs.',
    shipping_fee: '300', free_shipping_over: '9000', low_stock: '2', locations: '', bank_details: 'Bank: Test Bank\nAccount: 123', hero_link1_label: 'Shop', hero_link1_url: 'javascript:alert(1)' });
  const home = (await page('/')).text;
  assert.match(home, /Maison Test/);
  assert.match(home, /Hello &amp; welcome/);
  assert.match(home, /Line &lt;one&gt;/);
  assert.doesNotMatch(home, /javascript:alert/);
  assert.match((await page('/checkout')).text, /Bank transfer/);
  assert.equal((await postJson('/api/cart', { items: [{ id: variant, qty: 1 }] })).data.shipping, 0);
  await postForm('/admin/pages/new', { title: 'Size Guide', body: '## Tops\nMeasure across the chest.', in_footer: '1', sort: '9' });
  assert.match((await page('/pages/size-guide')).text, /<h2>Tops<\/h2>/);
  assert.match(home.length ? (await page('/')).text : '', /Size Guide/);
  await postForm('/admin/categories/new', { name: 'Kids', dept_woman: '1', show_home: '1', sort: '20', swatch: 'knit', sketch: 'tee' });
  assert.equal((await page('/collections/kids')).status, 200);
  assert.match((await page('/')).text, /\/collections\/kids\?dept=woman/);

  // --- samples can be cleared; password can be changed; log out ends the session
  await postForm('/admin/samples/delete', {});
  assert.equal((await page('/products/tweed-blazer')).status, 404);
  assert.equal((await page('/admin/orders/2')).status, 200, 'orders survive product deletion');
  await postForm('/admin/password', { current: 'test-password-1', next: 'another-password-2' });
  await postForm('/admin/logout', {});
  assert.equal((await page('/admin')).status, 303);
  assert.equal((await postForm('/admin/login', { username: 'admin', password: 'another-password-2' })).status, 303);
}

server.stdout.once('data', async () => {
  let failed = false;
  try { await run(); console.log('All checks passed.'); } catch (err) { failed = true; console.error(err); }
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});

'use strict';
// The shop the customer sees: pages plus the small JSON API the bag and checkout use.
const data = require('./data');
const { run } = require('./db');
const { esc, money, md, int, clean, fmtDate, limiter, ShopError } = require('./core');
const { SWATCHES, sketchSvg, ICON } = require('./art');

const V = Date.now().toString(36); // changes on every restart so browsers fetch fresh CSS/JS
const DEPT = { woman: 'Woman', man: 'Man' };
const SORT_LABEL = { newest: 'Newest', 'price-asc': 'Price: low to high', 'price-desc': 'Price: high to low', name: 'Name' };
const localUrl = (u, fallback = '/') => (/^\/(?!\/)/.test(String(u || '')) ? u : fallback);
const webUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? u : '');

// ------------------------------------------------------------------ layout

function navModel() {
  const cats = data.categories();
  const top = [];
  for (const dept of ['woman', 'man']) {
    const mine = cats.filter((c) => !c.in_nav && c.depts.split(',').includes(dept));
    top.push({
      label: DEPT[dept], url: `/collections/${dept}`,
      kids: [{ label: 'New In', url: `/collections/new-in?dept=${dept}` },
        ...mine.map((c) => ({ label: c.name, url: `/collections/${c.slug}?dept=${dept}` })),
        { label: 'View all', url: `/collections/${dept}` }],
    });
  }
  for (const c of cats.filter((x) => x.in_nav)) {
    const depts = c.depts.split(',').filter((d) => DEPT[d]);
    top.push({
      label: c.name, url: `/collections/${c.slug}`,
      kids: depts.length > 1 ? depts.map((d) => ({ label: DEPT[d], url: `/collections/${c.slug}?dept=${d}` })) : null,
    });
  }
  return top;
}

function layout({ title, description, body }) {
  const s = data.settings();
  const nav = navModel();
  const brand = esc(s.brand_name);
  const desktopNav = nav.map((item, i) => (item.kids
    ? `<li class="nav-item has-menu"><button class="nav-link" aria-expanded="false" aria-controls="menu-${i}">${esc(item.label)} ${ICON.chevDown}</button>
        <ul class="menu" id="menu-${i}">${item.kids.map((k) => `<li class="menu-item"><a class="menu-link" href="${esc(k.url)}">${esc(k.label)}</a></li>`).join('')}</ul></li>`
    : `<li class="nav-item"><a class="nav-link" href="${esc(item.url)}">${esc(item.label)}</a></li>`)).join('');
  const mobileNav = nav.map((item) => (item.kids
    ? `<li><details><summary>${esc(item.label)} ${ICON.chevDown}</summary><ul>${item.kids.map((k) => `<li><a href="${esc(k.url)}">${esc(k.label)}</a></li>`).join('')}</ul></details></li>`
    : `<li><a href="${esc(item.url)}">${esc(item.label)}</a></li>`)).join('');
  const footerPages = data.pages().filter((p) => p.in_footer)
    .map((p) => `<li><a href="/pages/${esc(p.slug)}">${esc(p.title)}</a></li>`).join('');
  const social = [['instagram', 'Instagram', webUrl(s.instagram_url)], ['facebook', 'Facebook', webUrl(s.facebook_url)]]
    .filter((x) => x[2]).map(([icon, label, url]) => `<a href="${esc(url)}" aria-label="${label}" target="_blank" rel="noopener">${ICON[icon]}</a>`).join('');
  const locations = String(s.locations || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');
  const contact = [s.contact_email, s.contact_phone, s.contact_hours, s.contact_days].filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title ? `${esc(title)} – ${brand}` : brand}</title>
${description || s.meta_description ? `<meta name="description" content="${esc(description || s.meta_description)}">` : ''}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gilda+Display&family=Raleway:wght@300;400;500;600&display=swap">
<link rel="stylesheet" href="/assets/css/site.css?v=${V}">
</head>
<body data-currency="${esc(s.currency)}">
${s.notice_text ? `<div class="notice on-dark"><p class="wrap">${esc(s.notice_text)}</p></div>` : ''}
<header class="header">
  <div class="wrap header-row">
    <button class="icon-btn burger" id="open-nav" aria-label="Open menu" aria-controls="nav-drawer" aria-expanded="false">${ICON.menu}</button>
    <a class="logo" href="/" aria-label="${brand} home">${brand}</a>
    <nav class="nav" aria-label="Main"><ul class="nav-list">${desktopNav}</ul></nav>
    <div class="tools">
      <button class="icon-btn" id="toggle-search" aria-label="Search" aria-controls="searchbar" aria-expanded="false">${ICON.search}</button>
      <a class="icon-btn hide-sm" href="/track" aria-label="Track your order" title="Track your order">${ICON.parcel}</a>
      <a class="icon-btn bag-link" href="/cart" aria-label="Bag">${ICON.bag}<span class="bag-count" data-bag-count hidden>0</span></a>
    </div>
  </div>
  <form class="searchbar" id="searchbar" role="search" action="/search" method="get" hidden>
    <div class="wrap"><div class="searchbar-row">
      <input id="search-input" name="q" type="search" placeholder="Search the collection" aria-label="Search the collection" autocomplete="off" required>
      <button class="caps" type="submit">Search</button>
    </div></div>
  </form>
</header>

<main>${body}</main>

<footer class="footer">
  <div class="wrap">
    <div class="ornament" aria-hidden="true">${ICON.needle}</div>
    <div class="footer-grid">
      <section>
        <h2>Learn More</h2>
        <ul>${footerPages}<li><a href="/track">Track Your Order</a></li></ul>
        ${social ? `<div class="social">${social}</div>` : ''}
      </section>
      <section><h2>Contact Us</h2>${contact}</section>
      <section>${locations ? `<details><summary>Our Locations ${ICON.plus}</summary>${locations}</details>` : ''}</section>
      <section>
        <h2>Join the List</h2>
        <p>Sign up now</p>
        <form class="signup" data-subscribe>
          <input id="signup-email" name="email" type="email" placeholder="Email address" aria-label="Email address" autocomplete="email" required>
          <button type="submit">Subscribe</button>
        </form>
        <p class="signup-note" data-subscribe-note hidden></p>
      </section>
    </div>
    <p class="copyright">Copyright © ${new Date().getFullYear()} ${brand}. All rights reserved.</p>
  </div>
</footer>

<div class="scrim" id="scrim"></div>
<aside class="drawer from-left" id="nav-drawer" aria-label="Menu" inert>
  <div class="drawer-head"><h2>Menu</h2><button class="icon-btn" data-close aria-label="Close menu">${ICON.close}</button></div>
  <ul class="drawer-nav">${mobileNav}<li><a href="/track">Track your order</a></li></ul>
</aside>
<button class="to-top" id="to-top" aria-label="Back to top">${ICON.up}</button>
<script src="/assets/js/site.js?v=${V}" defer></script>
</body>
</html>`;
}

// ------------------------------------------------------------------ pieces

function tile({ url, label, swatch, sketch, image, image2 }) {
  const media = image
    ? `<img src="${esc(image)}" alt="" loading="lazy">${image2 ? `<img class="alt" src="${esc(image2)}" alt="" loading="lazy">` : ''}`
    : sketchSvg(sketch);
  return `<a class="tile swatch sw-${esc(swatch)}" href="${esc(url)}">${media}<span class="tile-label">${esc(label)}</span>${image ? '' : `<span class="tile-cloth">${esc(SWATCHES[swatch] || '')}</span>`}</a>`;
}

function price(p, cur) {
  return p.compare_price > p.price
    ? `<span class="was">${money(p.compare_price, cur)}</span> <span class="now">${money(p.price, cur)}</span>`
    : money(p.price, cur);
}

function card(p, cur) {
  const media = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">${p.image2 ? `<img class="alt" src="${esc(p.image2)}" alt="" loading="lazy">` : ''}`
    : sketchSvg(p.sketch);
  const badge = p.stock <= 0 ? '<span class="badge badge-out">Sold out</span>' : p.is_new ? '<span class="badge">New</span>' : '';
  return `<a class="card" href="/products/${esc(p.slug)}">
    <div class="card-media swatch sw-${esc(p.swatch || 'linen')}">${media}${badge}</div>
    <span class="card-name">${esc(p.name)}</span><span class="card-price">${price(p, cur)}</span></a>`;
}

const grid = (products, cur) => `<div class="cards">${products.map((p) => card(p, cur)).join('')}</div>`;

function message(title, text, link = ['/', 'Back to the shop']) {
  return `<section class="wrap page narrow center"><h1>${esc(title)}</h1><p class="lede">${esc(text)}</p><p><a class="btn-line" href="${esc(link[0])}">${esc(link[1])}</a></p></section>`;
}

const notFound = () => layout({ title: 'Page not found', body: message('Page not found', 'The page you were looking for has moved or no longer exists.') });

// ------------------------------------------------------------------ pages

function home(ctx) {
  const s = data.settings();
  const tiles = [tile({ url: '/collections/new-in', label: 'New In', swatch: 'corduroy', sketch: 'hanger' }),
    ...data.categories().filter((c) => c.show_home).map((c) => tile({ url: `/collections/${c.slug}`, label: c.name, swatch: c.swatch, sketch: c.sketch, image: c.image, image2: c.image2 }))];
  const links = [[s.hero_link1_label, s.hero_link1_url], [s.hero_link2_label, s.hero_link2_url]]
    .filter((l) => l[0]).map(([label, url]) => `<a href="${esc(localUrl(url, '/collections/all'))}">${esc(label)}</a>`).join('');
  ctx.html(layout({ body: `
    <section class="hero swatch on-dark">${s.hero_image ? `<img src="${esc(s.hero_image)}" alt="">` : ''}
      <div class="hero-body wrap">
        <h1 class="hero-title"><span class="t1">${esc(s.hero_line1)}</span><span class="t2">${esc(s.hero_line2)}</span></h1>
        <div class="hero-links">${links}</div>
      </div>
    </section>
    <section class="wall" aria-label="Shop by category">${tiles.join('')}</section>` }));
}

function collection(ctx) {
  const s = data.settings();
  const slug = ctx.params.slug;
  const dept = DEPT[ctx.query.get('dept')] ? ctx.query.get('dept') : '';
  const sort = SORT_LABEL[ctx.query.get('sort')] ? ctx.query.get('sort') : 'newest';
  const opts = { sort };
  let title;
  let canFilter = true;
  if (slug === 'all') title = 'All Products';
  else if (slug === 'new-in') { title = 'New In'; opts.isNew = true; }
  else if (DEPT[slug]) { title = DEPT[slug]; opts.dept = slug; canFilter = false; }
  else {
    const c = data.category(slug);
    if (!c) return ctx.html(notFound(), 404);
    title = c.name; opts.cat = slug;
    canFilter = c.depts.split(',').filter(Boolean).length > 1;
  }
  if (canFilter && dept) opts.dept = dept;
  const products = data.listProducts(opts);
  const link = (d) => `/collections/${esc(slug)}?${new URLSearchParams({ ...(d ? { dept: d } : {}), ...(sort !== 'newest' ? { sort } : {}) })}`.replace(/\?$/, '');
  const chips = canFilter
    ? `<div class="chips">${[['', 'All'], ['woman', 'Woman'], ['man', 'Man']].map(([d, label]) => `<a class="chip${(opts.dept || '') === d ? ' is-on' : ''}" href="${link(d)}">${label}</a>`).join('')}</div>` : '<div></div>';
  ctx.html(layout({ title, body: `
    <section class="wrap page">
      <p class="crumbs"><a href="/">Home</a> / ${esc(title)}</p>
      <h1>${esc(title)}</h1>
      <div class="toolbar">${chips}
        <form class="sortform" method="get" data-autosubmit>
          ${canFilter && dept ? `<input type="hidden" name="dept" value="${dept}">` : ''}
          <label for="sort">Sort</label>
          <select id="sort" name="sort">${Object.entries(SORT_LABEL).map(([k, l]) => `<option value="${k}"${k === sort ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <noscript><button class="btn-line" type="submit">Apply</button></noscript>
        </form>
      </div>
      ${products.length ? `<p class="count">${products.length} ${products.length === 1 ? 'product' : 'products'}</p>${grid(products, s.currency)}`
    : '<div class="empty"><p>There are no products in this collection yet.</p><p><a class="btn-line" href="/collections/all">View all products</a></p></div>'}
    </section>` }));
}

function productPage(ctx) {
  const s = data.settings();
  const cur = s.currency;
  const p = data.productBySlug(ctx.params.slug);
  if (!p || !p.published) return ctx.html(notFound(), 404);
  const soldOut = p.stock <= 0;
  const firstAvailable = p.variants.find((v) => v.stock > 0);
  const gallery = p.images.length
    ? `<div class="gallery-main"><img id="gallery-main" src="${esc(p.images[0])}" alt="${esc(p.name)}"></div>
       ${p.images.length > 1 ? `<div class="thumbs">${p.images.map((u, i) => `<button type="button" class="thumb${i ? '' : ' is-on'}" data-thumb="${esc(u)}" aria-label="Photo ${i + 1}"><img src="${esc(u)}" alt=""></button>`).join('')}</div>` : ''}`
    : `<div class="gallery-main swatch sw-${esc(p.swatch || 'linen')}">${sketchSvg(p.sketch)}</div>`;
  const sizes = p.variants.map((v) => `<label class="size${v.stock > 0 ? '' : ' is-out'}"><input type="radio" name="variant" value="${v.id}" data-stock="${v.stock}"${v.stock > 0 ? '' : ' disabled'}${firstAvailable && firstAvailable.id === v.id ? ' checked' : ''}><span>${esc(v.size)}</span></label>`).join('');
  const fee = int(s.shipping_fee);
  const free = int(s.free_shipping_over);
  const delivery = [fee > 0 ? `Delivery ${money(fee, cur)}.` : 'Free delivery.', fee > 0 && free > 0 ? `Free on orders above ${money(free, cur)}.` : '', 'Pay in cash when your parcel arrives.'].filter(Boolean).join(' ');
  const related = p.cat_slug ? data.listProducts({ cat: p.cat_slug, exceptId: p.id, limit: 4 }) : [];
  ctx.html(layout({ title: p.name, description: p.description.slice(0, 160), body: `
    <section class="wrap page product">
      <p class="crumbs"><a href="/">Home</a>${p.cat_slug ? ` / <a href="/collections/${esc(p.cat_slug)}">${esc(p.cat_name)}</a>` : ''} / ${esc(p.name)}</p>
      <div class="product-grid">
        <div class="gallery">${gallery}</div>
        <div class="product-info">
          <h1>${esc(p.name)}</h1>
          <p class="product-price">${price(p, cur)}</p>
          <form data-product data-name="${esc(p.name)}" data-low="${int(s.low_stock)}">
            <fieldset class="sizes"><legend>Size</legend><div class="size-row">${sizes}</div></fieldset>
            <p class="stock-note" data-stock-note></p>
            <div class="buy-row">
              <div class="qty"><button type="button" data-qty="-1" aria-label="Fewer">−</button><input id="qty" name="qty" type="number" value="1" min="1" max="50" aria-label="Quantity"><button type="button" data-qty="1" aria-label="More">+</button></div>
              <button class="btn-solid" type="submit"${soldOut ? ' disabled' : ''}>${soldOut ? 'Sold out' : 'Add to bag'}</button>
            </div>
            <p class="added" data-added hidden></p>
          </form>
          <div class="prose">${md(p.description)}</div>
          <p class="delivery">${esc(delivery)}</p>
        </div>
      </div>
      ${related.length ? `<h2 class="section-title">More from ${esc(p.cat_name)}</h2>${grid(related, cur)}` : ''}
    </section>` }));
}

function search(ctx) {
  const q = clean(ctx.query.get('q'), 80);
  const products = q ? data.listProducts({ q, limit: 60 }) : [];
  ctx.html(layout({ title: 'Search', body: `
    <section class="wrap page">
      <h1>Search</h1>
      <form class="search-page" action="/search" method="get" role="search">
        <input id="q" name="q" type="search" value="${esc(q)}" placeholder="Search the collection" aria-label="Search the collection" required>
        <button class="btn-solid" type="submit">Search</button>
      </form>
      ${!q ? '' : products.length ? `<p class="count">${products.length} ${products.length === 1 ? 'result' : 'results'} for “${esc(q)}”</p>${grid(products, data.settings().currency)}`
    : `<div class="empty"><p>Nothing matches “${esc(q)}”. Try a shorter or different word.</p><p><a class="btn-line" href="/collections/all">View all products</a></p></div>`}
    </section>` }));
}

function cmsPage(ctx) {
  const p = data.page(ctx.params.slug);
  if (!p) return ctx.html(notFound(), 404);
  ctx.html(layout({ title: p.title, body: `<section class="wrap page narrow"><h1>${esc(p.title)}</h1><div class="prose">${md(p.body)}</div></section>` }));
}

function cart(ctx) {
  ctx.html(layout({ title: 'Your bag', body: `
    <section class="wrap page"><h1>Your Bag</h1>
      <div data-cart><p class="muted">Loading your bag…</p></div>
      <noscript><p>The bag needs JavaScript switched on in your browser.</p></noscript>
    </section>` }));
}

function checkout(ctx) {
  const s = data.settings();
  const bank = s.bank_details.trim();
  ctx.html(layout({ title: 'Checkout', body: `
    <section class="wrap page"><h1>Checkout</h1>
      <div class="checkout-grid">
        <form class="form" data-checkout novalidate>
          <h2>Delivery details</h2>
          <div class="field"><label for="co-name">Full name</label><input id="co-name" name="name" autocomplete="name" required></div>
          <div class="field"><label for="co-phone">Phone number</label><input id="co-phone" name="phone" type="tel" autocomplete="tel" required></div>
          <div class="field"><label for="co-email">Email <span class="opt">optional</span></label><input id="co-email" name="email" type="email" autocomplete="email"></div>
          <div class="field"><label for="co-address">Address</label><textarea id="co-address" name="address" rows="2" autocomplete="street-address" required></textarea></div>
          <div class="field"><label for="co-city">City</label><input id="co-city" name="city" autocomplete="address-level2" required></div>
          <div class="field"><label for="co-notes">Order notes <span class="opt">optional</span></label><textarea id="co-notes" name="notes" rows="2"></textarea></div>
          <div class="hp" aria-hidden="true"><label for="co-website">Website</label><input id="co-website" name="website" tabindex="-1" autocomplete="off"></div>
          <h2>Payment</h2>
          <label class="pay"><input type="radio" name="payment" value="cod" checked><span><strong>Cash on delivery</strong><small>Pay the courier in cash when your parcel arrives.</small></span></label>
          ${bank ? '<label class="pay"><input type="radio" name="payment" value="bank"><span><strong>Bank transfer</strong><small>Account details are shown after you place the order.</small></span></label>' : ''}
          <p class="form-error" data-error role="alert" hidden></p>
          <button class="btn-solid wide" type="submit">Place order</button>
        </form>
        <aside class="summary" data-summary><p class="muted">Loading your bag…</p></aside>
      </div>
    </section>` }));
}

function orderView(o, s) {
  const cur = s.currency;
  const steps = ['new', 'confirmed', 'shipped', 'delivered'];
  const at = steps.indexOf(o.status);
  const progress = o.status === 'cancelled'
    ? '<p class="status-cancelled">This order was cancelled.</p>'
    : `<ol class="steps">${steps.map((st, i) => `<li class="${i <= at ? 'done' : ''}${i === at ? ' current' : ''}">${i === 0 ? 'Received' : data.STATUS_LABEL[st]}</li>`).join('')}</ol>`;
  const pay = o.payment === 'bank' && s.bank_details.trim()
    ? `<h2>Bank transfer</h2><p>Transfer ${money(o.total, cur)} to the account below and mention order #${esc(o.number)}.</p><div class="bank">${md(s.bank_details)}</div>`
    : o.payment === 'cod' ? `<h2>Payment</h2><p>Pay ${money(o.total, cur)} in cash when your parcel arrives.</p>` : '';
  return `
    <section class="wrap page narrow">
      <p class="crumbs">Placed ${esc(fmtDate(o.created_at, s.timezone))}</p>
      <h1>Order #${esc(o.number)}</h1>
      ${progress}
      <table class="lines"><tbody>
        ${o.items.map((i) => `<tr><td>${esc(i.name)}<small>${esc(i.size)} × ${i.qty}</small></td><td class="num">${money(i.price * i.qty, cur)}</td></tr>`).join('')}
        <tr class="sub"><td>Subtotal</td><td class="num">${money(o.subtotal, cur)}</td></tr>
        <tr><td>Delivery</td><td class="num">${o.shipping ? money(o.shipping, cur) : 'Free'}</td></tr>
        <tr class="total"><td>Total</td><td class="num">${money(o.total, cur)}</td></tr>
      </tbody></table>
      ${pay}
      <h2>Delivery to</h2>
      <p>${esc(o.name)}<br>${esc(o.address)}${o.city ? `<br>${esc(o.city)}` : ''}<br>${esc(o.phone)}</p>
      <p class="muted">Keep your order number. You can come back to this page any time from “Track your order” with the number and your phone.</p>
      <p><a class="btn-line" href="/collections/all">Continue shopping</a></p>
    </section>`;
}

function orderPage(ctx) {
  const o = data.orderByNumber(ctx.params.number);
  if (!o || o.token !== ctx.params.token) return ctx.html(notFound(), 404);
  ctx.html(layout({ title: `Order #${o.number}`, body: orderView(o, data.settings()) }));
}

function trackForm(ctx, error = '', status = 200) {
  ctx.html(layout({ title: 'Track your order', body: `
    <section class="wrap page narrow"><h1>Track Your Order</h1>
      <p class="lede">Enter the order number from your confirmation and the phone number you ordered with.</p>
      <form class="form" method="post" action="/track">
        <div class="field"><label for="tr-number">Order number</label><input id="tr-number" name="number" inputmode="numeric" value="${esc(ctx.form.get('number') || '')}" required></div>
        <div class="field"><label for="tr-phone">Phone number</label><input id="tr-phone" name="phone" type="tel" autocomplete="tel" required></div>
        ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
        <button class="btn-solid" type="submit">Find my order</button>
      </form>
    </section>` }), status);
}

// ------------------------------------------------------------------ routes

const orderLimit = limiter(8, 10 * 60 * 1000);
const trackLimit = limiter(20, 10 * 60 * 1000);
const subscribeLimit = limiter(10, 10 * 60 * 1000);
const digits = (v) => String(v || '').replace(/\D/g, '');

function routes(app) {
  app.get('/', home);
  app.get('/collections/:slug', collection);
  app.get('/products/:slug', productPage);
  app.get('/pages/:slug', cmsPage);
  app.get('/search', search);
  app.get('/cart', cart);
  app.get('/checkout', checkout);
  app.get('/orders/:number/:token', orderPage);
  app.get('/track', (ctx) => trackForm(ctx));

  app.post('/track', (ctx) => {
    if (!trackLimit(ctx.ip)) return trackForm(ctx, 'Too many tries. Please wait a few minutes and try again.', 429);
    const o = data.orderByNumber(digits(ctx.form.get('number')));
    const phone = digits(ctx.form.get('phone'));
    if (!o || phone.length < 7 || digits(o.phone).slice(-7) !== phone.slice(-7)) {
      return trackForm(ctx, 'We could not find an order with that number and phone. Check both and try again.', 404);
    }
    ctx.redirect(`/orders/${o.number}/${o.token}`);
  });

  app.post('/api/cart', (ctx) => {
    const cart = data.priceCart(ctx.json && ctx.json.items);
    for (const line of cart.lines) line.media = line.image ? `<img src="${esc(line.image)}" alt="">` : sketchSvg(line.sketch);
    ctx.sendJson(cart);
  });

  app.post('/api/orders', (ctx) => {
    const body = ctx.json || {};
    if (body.website) return ctx.sendJson({ error: 'The order could not be placed.' }, 400); // filled only by bots
    if (!orderLimit(ctx.ip)) return ctx.sendJson({ error: 'Too many orders from this connection. Please wait a few minutes.' }, 429);
    try {
      const s = data.settings();
      const o = data.createOrder({
        items: body.items, customer: body.customer, source: 'website',
        payment: body.payment === 'bank' && s.bank_details.trim() ? 'bank' : 'cod',
      });
      ctx.sendJson({ url: `/orders/${o.number}/${o.token}` });
    } catch (err) {
      if (!(err instanceof ShopError)) throw err;
      ctx.sendJson({ error: err.message }, 400);
    }
  });

  app.post('/api/subscribe', (ctx) => {
    const email = clean(ctx.json && ctx.json.email, 160).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ctx.sendJson({ error: 'Please enter a valid email address.' }, 400);
    if (!subscribeLimit(ctx.ip)) return ctx.sendJson({ error: 'Please try again in a few minutes.' }, 429);
    run('INSERT OR IGNORE INTO subscribers (email, created_at) VALUES (?, ?)', email, new Date().toISOString());
    ctx.sendJson({ ok: true });
  });
}

module.exports = { routes, notFound, V };

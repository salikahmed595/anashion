(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var CUR = document.body.getAttribute('data-currency') || 'Rs.';
  function money(n) { return CUR + ' ' + Math.round(n).toLocaleString('en-US'); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; }); });
  }

  /* ---------- the bag lives in this browser until the order is placed ---------- */
  var memoryBag = [];
  function readBag() {
    var list;
    try { list = JSON.parse(localStorage.getItem('bag') || '[]'); } catch (e) { list = memoryBag; }
    if (!Array.isArray(list)) return [];
    return list.filter(function (i) { return i && i.id > 0 && i.qty > 0; });
  }
  function writeBag(list) {
    memoryBag = list;
    try { localStorage.setItem('bag', JSON.stringify(list)); } catch (e) { /* private window: keep it in memory */ }
    showCount();
  }
  function showCount() {
    var n = readBag().reduce(function (sum, i) { return sum + i.qty; }, 0);
    $$('[data-bag-count]').forEach(function (el) { el.textContent = n; el.hidden = !n; });
  }
  showCount();

  /* ---------- header: dropdowns, mobile menu, search ---------- */
  function setOpen(item, open) {
    item.classList.toggle('open', open);
    var btn = item.querySelector(':scope > button');
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }
  var menus = $$('.has-menu');
  function closeMenus(except) { menus.forEach(function (m) { if (m !== except) setOpen(m, false); }); }
  menus.forEach(function (item) {
    var hovered = false;
    item.addEventListener('pointerenter', function (e) { if (e.pointerType !== 'mouse') return; hovered = true; closeMenus(item); setOpen(item, true); });
    item.addEventListener('pointerleave', function (e) { if (e.pointerType !== 'mouse') return; hovered = false; setOpen(item, false); });
    item.querySelector(':scope > button').addEventListener('click', function () {
      if (hovered) { setOpen(item, true); return; }
      var willOpen = !item.classList.contains('open');
      closeMenus(item); setOpen(item, willOpen);
    });
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.has-menu')) closeMenus(); });

  var scrim = $('#scrim'), drawer = $('#nav-drawer'), openNav = $('#open-nav');
  function setDrawer(open) {
    if (!drawer) return;
    drawer.inert = !open; drawer.classList.toggle('is-open', open); scrim.classList.toggle('is-on', open);
    openNav.setAttribute('aria-expanded', String(open));
    if (open) drawer.querySelector('[data-close]').focus(); else if (document.activeElement && drawer.contains(document.activeElement)) openNav.focus();
  }
  if (openNav) {
    openNav.addEventListener('click', function () { setDrawer(true); });
    scrim.addEventListener('click', function () { setDrawer(false); });
    $$('[data-close]', drawer).forEach(function (b) { b.addEventListener('click', function () { setDrawer(false); }); });
  }

  var searchBtn = $('#toggle-search'), searchbar = $('#searchbar');
  if (searchBtn) {
    searchBtn.addEventListener('click', function () {
      var show = searchbar.hidden;
      searchbar.hidden = !show; searchBtn.setAttribute('aria-expanded', String(show));
      if (show) $('#search-input').focus();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeMenus(); setDrawer(false);
    if (searchbar && !searchbar.hidden) { searchbar.hidden = true; searchBtn.setAttribute('aria-expanded', 'false'); searchBtn.focus(); }
  });

  var toTop = $('#to-top');
  if (toTop) {
    var onScroll = function () { toTop.classList.toggle('is-on', window.scrollY > 400); };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
    toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  $$('[data-autosubmit] select').forEach(function (sel) { sel.addEventListener('change', function () { sel.form.submit(); }); });

  /* ---------- newsletter ---------- */
  $$('[data-subscribe]').forEach(function (form) {
    var note = $('[data-subscribe-note]', form.parentNode);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      post('/api/subscribe', { email: form.email.value }).then(function (r) {
        note.hidden = false;
        note.textContent = r.ok ? 'Thank you. You are on the list.' : (r.data.error || 'That did not work. Please try again.');
        if (r.ok) form.reset();
      }).catch(function () { note.hidden = false; note.textContent = 'No connection. Please try again.'; });
    });
  });

  /* ---------- product page ---------- */
  $$('[data-thumb]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $('#gallery-main').src = btn.getAttribute('data-thumb');
      $$('[data-thumb]').forEach(function (b) { b.classList.toggle('is-on', b === btn); });
    });
  });

  var productForm = $('[data-product]');
  if (productForm) {
    var low = Number(productForm.getAttribute('data-low')) || 0;
    var note = $('[data-stock-note]', productForm), added = $('[data-added]', productForm), qty = productForm.qty;
    var chosen = function () { return $('input[name="variant"]:checked', productForm); };
    var inBag = function (id) { var hit = readBag().filter(function (i) { return i.id === id; })[0]; return hit ? hit.qty : 0; };
    var refresh = function () {
      var c = chosen();
      if (!c) { note.textContent = ''; return; }
      var stock = Number(c.getAttribute('data-stock'));
      note.textContent = stock <= low ? 'Only ' + stock + ' left in this size.' : '';
      qty.max = Math.max(1, stock);
      if (Number(qty.value) > stock) qty.value = Math.max(1, stock);
    };
    $$('input[name="variant"]', productForm).forEach(function (r) { r.addEventListener('change', refresh); });
    $$('[data-qty]', productForm).forEach(function (b) {
      b.addEventListener('click', function () {
        var next = (Number(qty.value) || 1) + Number(b.getAttribute('data-qty'));
        qty.value = Math.min(Number(qty.max) || 50, Math.max(1, next));
      });
    });
    refresh();
    productForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var c = chosen();
      added.hidden = false;
      if (!c) { added.textContent = 'Please choose a size first.'; return; }
      var id = Number(c.value), stock = Number(c.getAttribute('data-stock'));
      var want = Math.max(1, Number(qty.value) || 1), have = inBag(id);
      var take = Math.min(want, stock - have);
      if (take <= 0) { added.innerHTML = 'You already have all ' + stock + ' of this size in your bag. <a href="/cart">View bag</a>'; return; }
      var bag = readBag().filter(function (i) { return i.id !== id; });
      bag.push({ id: id, qty: have + take });
      writeBag(bag);
      added.innerHTML = esc(productForm.getAttribute('data-name')) + ' added to your bag. <a href="/cart">View bag</a>';
    });
  }

  /* ---------- bag page and checkout summary ---------- */
  function loadBag() {
    return post('/api/cart', { items: readBag() }).then(function (r) {
      if (!r.ok) throw new Error('bag');
      var notes = [];
      r.data.lines.forEach(function (l) {
        if (l.stock <= 0) notes.push(l.name + ' (' + l.size + ') has sold out and was taken out of your bag.');
        else if (l.wanted > l.qty) notes.push('Only ' + l.stock + ' left of ' + l.name + ' (' + l.size + '), so the quantity was lowered.');
      });
      r.data.lines = r.data.lines.filter(function (l) { return l.qty > 0; });
      r.data.notes = notes;
      writeBag(r.data.lines.map(function (l) { return { id: l.id, qty: l.qty }; }));
      return r.data;
    });
  }
  function totalsHtml(bag) {
    return '<p class="sum-line"><span>Subtotal</span><span class="num">' + money(bag.subtotal) + '</span></p>' +
      '<p class="sum-line"><span>Delivery</span><span class="num">' + (bag.shipping ? money(bag.shipping) : 'Free') + '</span></p>' +
      '<p class="sum-line sum-total"><span>Total</span><span class="num">' + money(bag.total) + '</span></p>';
  }
  var emptyBag = '<div class="empty"><p>Your bag is empty.</p><p><a class="btn-line" href="/collections/all">Continue shopping</a></p></div>';
  var offline = '<p class="form-error">We could not load your bag. Check your connection and reload the page.</p>';

  var cartRoot = $('[data-cart]');
  function drawCart(bag) {
    var notes = bag.notes.length ? '<p class="cart-notes">' + bag.notes.map(esc).join('<br>') + '</p>' : '';
    if (!bag.lines.length) { cartRoot.innerHTML = notes + emptyBag; return; }
    var hint = bag.freeOver > 0 && bag.shipping > 0 ? '<p class="sum-hint">Add ' + money(bag.freeOver - bag.subtotal) + ' more for free delivery.</p>' : '';
    cartRoot.innerHTML = notes + '<div class="cart-grid"><div>' + bag.lines.map(function (l) {
      return '<div class="cart-line" data-id="' + l.id + '">' +
        '<a class="card-media swatch sw-' + esc(l.swatch) + '" href="/products/' + esc(l.slug) + '" aria-label="' + esc(l.name) + '">' + l.media + '</a>' +
        '<div><h3><a href="/products/' + esc(l.slug) + '">' + esc(l.name) + '</a></h3><small>Size ' + esc(l.size) + ' · ' + money(l.price) + '</small>' +
        '<div class="line-controls"><div class="qty small"><button type="button" data-step="-1" aria-label="One fewer">−</button><span>' + l.qty + '</span>' +
        '<button type="button" data-step="1" aria-label="One more"' + (l.qty >= l.stock ? ' disabled' : '') + '>+</button></div>' +
        '<button class="link" type="button" data-step="0">Remove</button></div></div>' +
        '<strong class="num">' + money(l.price * l.qty) + '</strong></div>';
    }).join('') + '</div><aside class="summary"><h2>Summary</h2>' + totalsHtml(bag) + hint +
      '<a class="btn-solid wide" href="/checkout">Checkout</a></aside></div>';
  }
  function refreshCart() { loadBag().then(drawCart).catch(function () { cartRoot.innerHTML = offline; }); }
  if (cartRoot) {
    cartRoot.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-step]');
      if (!btn) return;
      var id = Number(btn.closest('[data-id]').getAttribute('data-id')), step = Number(btn.getAttribute('data-step'));
      writeBag(readBag().map(function (i) { return i.id === id ? { id: id, qty: step ? i.qty + step : 0 } : i; }));
      refreshCart();
    });
    refreshCart();
  }

  var checkoutForm = $('[data-checkout]'), summary = $('[data-summary]');
  if (checkoutForm) {
    var error = $('[data-error]', checkoutForm), submit = $('button[type="submit"]', checkoutForm);
    var fail = function (text) { error.textContent = text; error.hidden = false; submit.disabled = false; submit.textContent = 'Place order'; error.scrollIntoView({ block: 'center' }); };
    var drawSummary = function (bag) {
      if (!bag.lines.length) { window.location.replace('/cart'); return; }
      summary.innerHTML = '<h2>Your order</h2>' + (bag.notes.length ? '<p class="warn">' + bag.notes.map(esc).join('<br>') + '</p>' : '') + bag.lines.map(function (l) {
        return '<p class="sum-line"><span>' + esc(l.name) + '<small>Size ' + esc(l.size) + ' × ' + l.qty + '</small></span><span class="num">' + money(l.price * l.qty) + '</span></p>';
      }).join('') + totalsHtml(bag) + '<p><a class="link" href="/cart">Edit bag</a></p>';
    };
    loadBag().then(drawSummary).catch(function () { summary.innerHTML = offline; });
    checkoutForm.addEventListener('submit', function (e) {
      e.preventDefault();
      error.hidden = true; submit.disabled = true; submit.textContent = 'Placing your order…';
      var f = checkoutForm, v = function (n) { return f.elements[n].value; };
      post('/api/orders', {
        items: readBag(), website: v('website'), payment: v('payment'),
        customer: { name: v('name'), phone: v('phone'), email: v('email'), address: v('address'), city: v('city'), notes: v('notes') }
      }).then(function (r) {
        if (!r.ok || !r.data.url) { fail(r.data.error || 'The order could not be placed. Please try again.'); loadBag().then(drawSummary).catch(function () {}); return; }
        writeBag([]);
        window.location.href = r.data.url;
      }).catch(function () { fail('No connection. Your order was not placed. Please try again.'); });
    });
  }
})();

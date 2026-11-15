(function () {
  'use strict';
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* Ask before anything that cannot be undone. */
  $$('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) { if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault(); });
  });

  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  /* Repeating rows: sizes on a product, items on a phone order. */
  $$('[data-add-row]').forEach(function (btn) {
    var form = btn.closest('form');
    btn.addEventListener('click', function () {
      var body = form.querySelector('[data-rows] tbody');
      body.appendChild(form.querySelector('[data-row-template]').content.cloneNode(true));
      var input = body.lastElementChild.querySelector('input:not([type="hidden"]), select');
      if (input) input.focus();
    });
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove-row]');
    if (!btn) return;
    var body = btn.closest('tbody');
    if (body.children.length > 1) btn.closest('tr').remove();
  });

  /* Photos: each file is uploaded on its own, then its address is posted with the form. */
  $$('[data-uploader]').forEach(function (box) {
    var list = box.querySelector('.img-list'), input = box.querySelector('[data-img-input]'), note = box.querySelector('[data-upload-note]');
    var name = box.getAttribute('data-name'), single = box.hasAttribute('data-single');
    function addItem(url) {
      var item = document.createElement('div');
      item.className = 'img-item';
      var img = document.createElement('img'); img.src = url; img.alt = '';
      var hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = name; hidden.value = url;
      var actions = document.createElement('div'); actions.className = 'img-actions';
      actions.innerHTML = (single ? '' : '<button type="button" data-img-first>Make first</button>') + '<button type="button" data-img-remove>Remove</button>';
      item.appendChild(img); item.appendChild(hidden); item.appendChild(actions);
      if (single) list.innerHTML = '';
      list.appendChild(item);
    }
    box.addEventListener('click', function (e) {
      var item = e.target.closest('.img-item');
      if (!item) return;
      if (e.target.closest('[data-img-remove]')) item.remove();
      if (e.target.closest('[data-img-first]')) list.insertBefore(item, list.firstChild);
    });
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files);
      note.textContent = files.length ? 'Uploading…' : '';
      var failed = [];
      files.reduce(function (chain, file) {
        return chain.then(function () {
          return fetch('/admin/upload', { method: 'POST', headers: { 'Content-Type': file.type, Accept: 'application/json' }, body: file })
            .then(function (res) { return res.json().then(function (data) { if (res.ok && data.url) addItem(data.url); else failed.push(file.name + ': ' + (data.error || 'could not be uploaded')); }); })
            .catch(function () { failed.push(file.name + ': could not be uploaded'); });
        });
      }, Promise.resolve()).then(function () {
        note.textContent = failed.length ? failed.join(' · ') : 'Uploaded. Save the form to keep the change.';
        note.style.color = failed.length ? '' : 'var(--ok)';
        input.value = '';
      });
    });
  });
})();

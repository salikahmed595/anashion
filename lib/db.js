'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, token } = require('./core');

// Everything that must survive a restart (database + uploaded photos) lives in DATA_DIR.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'store.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, expires TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  depts TEXT NOT NULL DEFAULT '',            -- '', 'woman', 'man' or 'woman,man'
  show_home INTEGER NOT NULL DEFAULT 1, in_nav INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  swatch TEXT NOT NULL DEFAULT 'linen', sketch TEXT NOT NULL DEFAULT 'hanger',
  image TEXT NOT NULL DEFAULT '', image2 TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0, compare_price INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  dept TEXT NOT NULL DEFAULT '',             -- 'woman', 'man' or '' (everyone)
  is_new INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', source TEXT NOT NULL DEFAULT 'website', payment TEXT NOT NULL DEFAULT 'cod',
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  admin_notes TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  name TEXT NOT NULL, size TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL, qty INTEGER NOT NULL
);

-- Every change to a stock number is written here, so stock can always be explained.
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  in_footer INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_moves_variant ON stock_moves(variant_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
`);

const prepared = new Map();
function stmt(sql) {
  let s = prepared.get(sql);
  if (!s) { s = db.prepare(sql); prepared.set(sql, s); }
  return s;
}
const get = (sql, ...args) => stmt(sql).get(...args);
const all = (sql, ...args) => stmt(sql).all(...args);
const run = (sql, ...args) => stmt(sql).run(...args);

let depth = 0;
/** Run fn inside one database transaction; any error undoes all of it. */
function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth -= 1;
  }
}

// ---------------------------------------------------------------- first run

const DEFAULT_SETTINGS = {
  brand_name: 'your label',
  notice_text: 'Free shipping on orders above Rs. 5,000',
  hero_line1: 'Dressed for',
  hero_line2: 'the everyday',
  hero_image: '',
  hero_link1_label: 'Shop Man', hero_link1_url: '/collections/man',
  hero_link2_label: 'Shop Woman', hero_link2_url: '/collections/woman',
  contact_email: 'hello@yourlabel.com',
  contact_phone: '0300-000-0000',
  contact_hours: '10:00 AM to 7:00 PM',
  contact_days: 'Monday – Saturday',
  locations: 'Studio address, city\nVisits by appointment',
  instagram_url: '', facebook_url: '',
  currency: 'Rs.',
  shipping_fee: '250',
  free_shipping_over: '5000',
  low_stock: '3',
  bank_details: '',
  timezone: 'Asia/Karachi',
  meta_description: '',
};

function seed() {
  const now = new Date().toISOString();
  tx(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);

    if (get('SELECT COUNT(*) AS n FROM categories').n > 0) return;

    const cats = [
      ['tops', 'Tops', 'woman,man', 0, 'linen', 'tee', '', ''],
      ['bottoms', 'Bottoms', 'woman,man', 0, 'denim', 'trousers', '', ''],
      ['dresses', 'Dresses', 'woman', 0, 'jacquard', 'dress', '', ''],
      ['jackets', 'Jackets', 'woman,man', 0, 'tweed', 'blazer', '/assets/images/jackets-front.webp', '/assets/images/jackets-back.webp'],
      ['sweaters', 'Sweaters', 'woman,man', 0, 'knit', 'sweater', '', ''],
      ['shoes', 'Shoes', 'woman,man', 1, 'suede', 'shoe', '', ''],
      ['bags', 'Bags', '', 1, 'leather', 'bag', '', ''],
      ['accessories', 'Accessories', '', 1, 'wool', 'sunglasses', '', ''],
      ['homeware', 'Homeware', '', 1, 'velvet', 'candle', '', ''],
    ];
    const catId = {};
    cats.forEach(([slug, name, depts, inNav, swatch, sketch, image, image2], i) => {
      const r = run('INSERT INTO categories (slug, name, depts, show_home, in_nav, sort, swatch, sketch, image, image2) VALUES (?,?,?,?,?,?,?,?,?,?)',
        slug, name, depts, 1, inNav, i, swatch, sketch, image, image2);
      catId[slug] = Number(r.lastInsertRowid);
    });

    // Sample catalogue so the shop and the admin can be tried straight away.
    // Names, prices and stock are invented; delete them from Admin > Products.
    const CLOTHES = ['S', 'M', 'L', 'XL'];
    const samples = [
      ['Bomber Jacket', 'jackets', 'man', 14500, 0, 1, CLOTHES, [4, 6, 5, 2], ['/assets/images/jackets-front.webp', '/assets/images/jackets-back.webp'],
        'Black nylon bomber with a ribbed collar, zip sleeve pocket and a printed back.'],
      ['Tweed Blazer', 'jackets', 'woman', 12800, 0, 0, CLOTHES, [3, 4, 2, 0], [], 'Single-breasted blazer in a herringbone tweed.'],
      ['Linen Camp Shirt', 'tops', 'man', 4500, 0, 1, CLOTHES, [8, 10, 7, 3], [], 'Relaxed short-sleeve shirt in washed linen.'],
      ['Boxy Cotton Tee', 'tops', 'woman', 2800, 3400, 0, CLOTHES, [12, 9, 6, 4], [], 'Heavyweight cotton tee with a boxy cut.'],
      ['Wide-Leg Trousers', 'bottoms', 'woman', 6200, 0, 1, CLOTHES, [5, 5, 3, 1], [], 'High-waisted trousers with a wide, full-length leg.'],
      ['Straight Denim', 'bottoms', 'man', 6800, 0, 0, ['30', '32', '34', '36'], [4, 7, 6, 2], [], 'Mid-weight denim in a straight fit.'],
      ['Tiered Midi Dress', 'dresses', 'woman', 9400, 0, 1, CLOTHES, [3, 4, 2, 1], [], 'Sleeveless midi dress with a tiered skirt.'],
      ['Cable Knit Sweater', 'sweaters', 'woman', 7600, 0, 0, CLOTHES, [6, 5, 0, 0], [], 'Chunky cable knit with ribbed cuffs and hem.'],
      ['Merino Crewneck', 'sweaters', 'man', 8200, 0, 0, CLOTHES, [5, 6, 4, 2], [], 'Fine-gauge merino crewneck.'],
      ['Suede Loafer', 'shoes', 'man', 11500, 0, 0, ['40', '41', '42', '43', '44'], [2, 3, 4, 3, 1], [], 'Unlined suede loafer with a leather sole.'],
      ['Leather Mule', 'shoes', 'woman', 8900, 0, 1, ['36', '37', '38', '39', '40'], [2, 4, 4, 2, 0], [], 'Flat leather mule with a square toe.'],
      ['Soft Leather Tote', 'bags', '', 15800, 0, 0, ['One size'], [6], [], 'Unstructured tote in soft grain leather.'],
      ['Wool Check Scarf', 'accessories', '', 3600, 0, 0, ['One size'], [14], [], 'Woven wool scarf in a tonal check.'],
      ['Scented Candle', 'homeware', '', 2400, 0, 0, ['One size'], [20], [], 'Hand-poured candle in a glass jar.'],
    ];
    samples.forEach(([name, cat, dept, price, compare, isNew, sizes, stock, images, description], i) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const created = new Date(Date.now() - i * 3600e3).toISOString();
      const p = Number(run('INSERT INTO products (slug, name, description, price, compare_price, category_id, dept, is_new, published, is_sample, created_at) VALUES (?,?,?,?,?,?,?,?,1,1,?)',
        slug, name, description, price, compare, catId[cat], dept, isNew, created).lastInsertRowid);
      images.forEach((url, n) => run('INSERT INTO product_images (product_id, url, sort) VALUES (?,?,?)', p, url, n));
      sizes.forEach((size, n) => {
        const sku = `${slug.split('-').map((w) => w[0]).join('').toUpperCase()}-${String(size).replace(/\s+/g, '').toUpperCase().slice(0, 3)}`;
        const v = Number(run('INSERT INTO variants (product_id, size, sku, stock, sort) VALUES (?,?,?,?,?)', p, size, sku, stock[n], n).lastInsertRowid);
        if (stock[n] > 0) run('INSERT INTO stock_moves (variant_id, delta, reason, note, created_at) VALUES (?,?,?,?,?)', v, stock[n], 'restock', 'Opening stock', now);
      });
    });

    const placeholder = (what) => `This page is waiting for your ${what}.\n\nTo write it, sign in to the admin panel, open Pages and edit this page.`;
    [
      ['about', 'About Us', placeholder('story: who you are, how the label started and how the clothes are made')],
      ['privacy-policy', 'Privacy Policy', placeholder('privacy policy: what customer details you collect and how you use them')],
      ['returns', 'Return & Exchange Policy', placeholder('return and exchange rules: how many days, in what condition, and who pays for delivery')],
      ['faq', 'Frequently Asked Questions', '## How do I place an order?\nAdd items to your bag, open the bag and fill in the checkout form.\n\n## How do I pay?\nPayment is collected in cash when the parcel is delivered.\n\n## Where is my order?\nOpen "Track your order" at the bottom of any page and enter your order number and phone number.'],
    ].forEach(([slug, title, body], i) => run('INSERT INTO pages (slug, title, body, in_footer, sort) VALUES (?,?,?,1,?)', slug, title, body, i));
  });

  if (!get('SELECT id FROM admins LIMIT 1')) {
    const password = process.env.ADMIN_PASSWORD || token(6);
    const { salt, hash } = hashPassword(password);
    run('INSERT INTO admins (username, pass_hash, salt) VALUES (?,?,?)', 'admin', hash, salt);
    if (!process.env.ADMIN_PASSWORD) {
      console.log('\n  Admin account created.');
      console.log('    username: admin');
      console.log(`    password: ${password}`);
      console.log('  Write this down: it is shown only once. Change it under Admin > Settings.\n');
    }
  }
}
seed();

module.exports = { db, get, all, run, tx, DATA_DIR, UPLOAD_DIR };

# Fashion store

An online shop with its own admin panel, in one small Node.js app.

- **Shop**: home page, collections, product pages, search, bag, checkout (cash on delivery, optional bank transfer), order confirmation and order tracking, plus editable information pages.
- **Admin** (`/admin`): orders, phone/WhatsApp/in-store order entry, products and photos, inventory with a full stock history, categories, pages, newsletter subscribers and shop settings.

There is nothing to install. It needs **Node.js 22.13 or newer** and uses Node's built-in SQLite database.

## Run it

```bash
node server.js
```

Then open http://localhost:3000 for the shop and http://localhost:3000/admin for the admin panel.

On the first start an admin account is created and its password is printed in the terminal **once**. The username is `admin`. Change the password under Admin > Settings. To choose the first password yourself, start with `ADMIN_PASSWORD=your-password node server.js`.

The shop starts with sample products so every screen has something in it. Delete them from the admin dashboard before opening to customers.

## Settings you can pass when starting

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the site listens on |
| `DATA_DIR` | `./data` | Folder for the database and uploaded photos |
| `ADMIN_PASSWORD` | random | Password for the first admin account (first start only) |

## Your data

Everything that matters is in `DATA_DIR`: `store.db` (products, stock, orders, pages, settings) and `uploads/` (photos). Back this folder up regularly.

When hosting, `DATA_DIR` must be on storage that survives restarts and redeploys (a persistent disk or volume). On hosts whose file system is wiped on each deploy, orders and products would be lost.

Static hosting such as GitHub Pages cannot run this app, because orders and stock need a server.

## Check that everything works

```bash
npm test
```

This starts the app on a temporary database and walks through browsing, ordering, stock changes and the admin panel.

## Where things are

| Path | Contents |
|---|---|
| `server.js` | Web server and routing |
| `lib/shop.js` | Shop pages and the bag/checkout endpoints |
| `lib/admin.js` | Admin panel |
| `lib/data.js` | Rules for products, stock and orders |
| `lib/db.js` | Database tables and first-run sample data |
| `public/` | Styles, browser scripts and built-in images |

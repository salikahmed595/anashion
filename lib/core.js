'use strict';
const crypto = require('node:crypto');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function money(n, cur) {
  return `${cur || 'Rs.'} ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/** Whole number from user input ("1,200" -> 1200). */
function int(v, def = 0) {
  const n = parseInt(String(v ?? '').replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : def;
}

/** Trimmed, length-limited text without control characters. */
function clean(v, max = 500) {
  return String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Small, safe text format for pages and descriptions:
 * blank line = new paragraph, "## " = heading, "- " = list item, **bold**.
 */
function md(text) {
  return String(text || '').replace(/\r/g, '').split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    let out = '';
    if (lines[0].startsWith('## ')) out += `<h2>${inline(lines.shift().slice(3))}</h2>`;
    if (!lines.length) return out;
    if (lines.every((l) => l.startsWith('- '))) {
      return `${out}<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    }
    return `${out}<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

function fmtDate(iso, tz) {
  const opts = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  try { return new Date(iso).toLocaleString('en-GB', { ...opts, timeZone: tz || 'UTC' }); }
  catch { return new Date(iso).toLocaleString('en-GB', { ...opts, timeZone: 'UTC' }); }
}

/** Calendar day (YYYY-MM-DD) of a timestamp in the shop's time zone. */
function dayKey(iso, tz) {
  try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz || 'UTC' }); }
  catch { return new Date(iso).toISOString().slice(0, 10); }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

function hashPassword(password, salt = token(16)) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function verifyPassword(password, salt, hash) {
  const a = crypto.scryptSync(String(password), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** In-memory rate limiter: allow `max` hits per key inside `windowMs`. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    const ok = list.length < max;
    if (ok) list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return ok;
  };
}

/** Error whose message is safe to show to the person using the site. */
class ShopError extends Error {}

module.exports = { esc, slugify, money, int, clean, md, fmtDate, dayKey, parseCookies, token, hashPassword, verifyPassword, limiter, ShopError };

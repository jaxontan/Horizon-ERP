import { createServer } from 'node:http';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { readFile, stat, mkdir, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Busboy from 'busboy';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config({ quiet: true });

// ── Performance: HTTP Keep-Alive Agent for connection reuse ──────────────────
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 25, maxFreeSockets: 10 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 25, maxFreeSockets: 10 });

function getAgentForUrl(url) {
  return url?.startsWith('https') ? httpsAgent : httpAgent;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);

// ── Local upload destination ──────────────────────────────────────────────────
// Files are written to ./uploads/<category>/<YYYY-MM-DD>/ and served back from
// the same Node process via GET /uploads/<category>/<YYYY-MM-DD>/<file>.
// No Supabase Storage dependency — just a folder on disk.
const UPLOAD_DIR_NAME = String(process.env.UPLOAD_DIR || 'uploads').trim() || 'uploads';
const uploadsRoot = path.join(rootDir, UPLOAD_DIR_NAME);
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024); // 10 MB

// Per-category MIME allowlist. Keeping MIME restrictions scoped to the bucket
// means we can safely accept .docx brochures for `outreach` without letting
// the same type land in `avatars` (which is image-only by design) — and stops
// a misconfigured client from landing a `.exe` into a sensitive bucket.
//
// Override defaults via env: UPLOAD_ALLOWED_MIME_<CATEGORY>=... (comma-separated)
// Or wipe the entire map by setting UPLOAD_ALLOWED_MIME to a single CSV
// (applied to every category as a fallback that loses the per-category
// granularity — included for backward compatibility).
const UPLOAD_ALLOWED_MIME_BY_CATEGORY = Object.freeze({
  documents:        'application/pdf,image/jpeg,image/png,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'purchase-records':'application/pdf,image/jpeg,image/png,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  receipts:         'application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  outreach:         'application/pdf,image/jpeg,image/png,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/json,text/plain',
  support:          'application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,text/plain,application/json',
  avatars:          'image/jpeg,image/png,image/webp',
  misc:             'application/pdf,image/jpeg,image/png,image/webp,text/csv,application/json,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

function parseMimeCsv(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function buildAllowedMimeSets() {
  const sets = {};
  // Legacy single-list override applied to every category.
  const legacyCsv = process.env.UPLOAD_ALLOWED_MIME;
  const legacy = legacyCsv ? parseMimeCsv(legacyCsv) : null;
  for (const category of Object.keys(UPLOAD_ALLOWED_MIME_BY_CATEGORY)) {
    const envKey = `UPLOAD_ALLOWED_MIME_${category.replace(/[^a-z0-9_]/gi, '_').toUpperCase()}`;
    const csv = process.env[envKey] || UPLOAD_ALLOWED_MIME_BY_CATEGORY[category];
    const set = parseMimeCsv(csv);
    if (legacy) {
      for (const m of legacy) set.add(m);
    }
    sets[category] = set;
  }
  return sets;
}

const UPLOAD_ALLOWED_MIME = buildAllowedMimeSets(); // { category: Set<MIME> }
const UPLOAD_DEFAULT_MIME_FALLBACK = parseMimeCsv('application/pdf,image/jpeg,image/png');

function mimeAllowedForCategory(category, mime) {
  const set = UPLOAD_ALLOWED_MIME[category];
  if (set) return set.has(mime);
  return UPLOAD_DEFAULT_MIME_FALLBACK.has(mime);
}

const UPLOAD_ALLOWED_CATEGORIES = new Set([
  'documents',         // tax certs, D&B, incorporation (business-onboarding.html)
  'purchase-records',  // PO / GRN / supplier invoice (document/purchase-record.html)
  'receipts',          // invoice/receipt uploads (finances/account.html)
  'outreach',          // csv contacts + email attachments (outreach/email-outreach.html)
  'support',           // chat attachments from support.html (customer-management/support.html)
  'avatars',           // future customer portal
  'misc',
]);

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseProjectRef = process.env.SUPABASE_PROJECT_REF || getProjectRefFromUrl(supabaseUrl);
const supabaseManagementToken =
  process.env.SUPABASE_ACCESS_TOKEN ||
  process.env.SUPABASE_PAT ||
  readLocalPat();

// ── OpenRouter (AI auto-reply) ────────────────────────────────────────────────
const OPENROUTER_API_KEY = String(process.env.OPENROUTER_API_KEY || '').trim();
const OPENROUTER_MODEL = String(process.env.MODEL || 'meta-llama/llama-3.3-70b-instruct').trim();
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_REPLY_COOLDOWN_MS = Number(process.env.AI_REPLY_COOLDOWN_MS || 2000); // 2 seconds
const AI_REPLY_DAILY_CAP = Number(process.env.AI_REPLY_DAILY_CAP || 50);

const supabaseAdmin = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      db: { schema: 'public' },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        fetch: (url, options) => {
          return fetch(url, {
            ...options,
            agent: getAgentForUrl(url),
          });
        },
      },
    })
  : null;

const sqlProxyConfigured = Boolean(supabaseProjectRef && supabaseManagementToken);
let sqlProxyDisabled = false;

// ── Brevo SMTP / Outreach configuration ────────────────────────────────────────
// Reuses the Brevo SMTP relay (no domain required, 300 emails/day free).
// When OUTREACH_SANDBOX_MODE=true (default), /api/outreach/dispatch returns the
// list of recipients it WOULD have emailed without opening an SMTP connection.
// Flip OUTREACH_SANDBOX_MODE=false in .env only after verifying a single test
// recipient lands in your own inbox.
const BREVO_SMTP_LOGIN = String(process.env.BREVO_SMTP_LOGIN || '').trim();
const BREVO_SMTP_KEY = String(process.env.BREVO_SMTP_KEY || '').trim();
const BREVO_FROM_B2C = String(process.env.BREVO_FROM_B2C || '').trim();
const BREVO_FROM_B2B = String(process.env.BREVO_FROM_B2B || '').trim();
const BREVO_REPLY_TO = String(process.env.BREVO_REPLY_TO || '').trim();
const OUTREACH_SANDBOX_MODE = String(process.env.OUTREACH_SANDBOX_MODE || 'true').toLowerCase() !== 'false';
const OUTREACH_MAX_RECIPIENTS_PER_RUN = Math.max(
  1,
  Number(process.env.OUTREACH_MAX_RECIPIENTS_PER_RUN || 50) || 50
);
const OUTREACH_DELAY_BETWEEN_MS = Math.max(
  0,
  Number(process.env.OUTREACH_DELAY_BETWEEN_MS || 1500) || 1500
);

const brevoMailerConfigured = Boolean(BREVO_SMTP_LOGIN && BREVO_SMTP_KEY);
let brevoTransporter = null;
function getBrevoTransporter() {
  if (!brevoMailerConfigured) return null;
  if (brevoTransporter) return brevoTransporter;
  brevoTransporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: {
      user: BREVO_SMTP_LOGIN,
      pass: BREVO_SMTP_KEY,
    },
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 15000,
  });
  return brevoTransporter;
}

function resolveOutreachFromAddress(segment) {
  const raw = segment === 'b2b' ? BREVO_FROM_B2B : BREVO_FROM_B2C;
  if (!raw) return null;
  // Accept either a full "Name <addr@host>" or a bare email.
  const match = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<\s*([^>]+)\s*>\s*$/);
  if (match) {
    const name = String(match[1] || '').trim();
    const addr = String(match[2] || '').trim();
    if (!addr) return null;
    return name ? { name, address: addr } : addr;
  }
  return raw.includes('@') ? raw.trim() : null;
}

// Stale-while-revalidate cache with request coalescing
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes fresh
// Cache entries: key → { data, staleTime, fetching }
const columnCache = new Map();
const primaryKeyCache = new Map();

// Server-side query result cache (performance optimization)
const QUERY_CACHE_TTL_MS = 30 * 1000; // 30 seconds for query results
const queryResultCache = new Map();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseCycleLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const parts = label.split(' ');
  if (parts.length !== 2) return null;
  const monthIdx = MONTHS.indexOf(parts[0]);
  const year = parseInt(parts[1], 10);
  if (monthIdx < 0 || isNaN(year)) return null;
  return { year, month: monthIdx };
}

function cycleDateRange(label) {
  const parsed = parseCycleLabel(label);
  if (!parsed) return null;
  const start = new Date(parsed.year, parsed.month, 1);
  const end = new Date(parsed.year, parsed.month + 1, 1);
  return { start, end };
}

function getNextCycleLabel(label) {
  const parsed = parseCycleLabel(label);
  if (!parsed) return null;
  let nextMonth = parsed.month + 1;
  let nextYear = parsed.year;
  if (nextMonth > 11) {
    nextMonth = 0;
    nextYear += 1;
  }
  return `${MONTHS[nextMonth]} ${nextYear}`;
}

const defaultPayrollSettings = {
  pay_day: 25,
  payroll_lock_hour: 23,
  payroll_lock_min: 59,
  payroll_adjustment_days: 7,
};

async function getCompanySettings() {
  if (!supabaseAdmin) return defaultPayrollSettings;
  try {
    const { data } = await supabaseAdmin.from('company_settings').select('*').limit(1).single();
    if (data) {
      return {
        pay_day: Number(data.pay_day ?? 25),
        payroll_lock_hour: Number(data.payroll_lock_hour ?? 23),
        payroll_lock_min: Number(data.payroll_lock_min ?? 59),
        payroll_adjustment_days: Number(data.payroll_adjustment_days ?? 7),
      };
    }
  } catch (err) {
    console.warn('[getCompanySettings] fallback to defaults:', err.message);
  }
  return defaultPayrollSettings;
}

async function getCycleStage(cycleLabel) {
  const settings = await getCompanySettings();
  if (!cycleLabel) return 'Paid';
  const range = cycleDateRange(cycleLabel);
  if (!range) return 'Paid';

  const payDay = settings.pay_day;
  const adjustmentDays = settings.payroll_adjustment_days ?? 7;
  const year = range.start.getFullYear();
  const month = range.start.getMonth();

  const maxDays = new Date(year, month + 1, 0).getDate();
  const clampedPayDay = Math.min(payDay, maxDays);

  const payDayTriggerDate = new Date(year, month, clampedPayDay, settings.payroll_lock_hour, settings.payroll_lock_min);
  const lockDate = new Date(year, month, clampedPayDay + adjustmentDays, settings.payroll_lock_hour, settings.payroll_lock_min);

  const now = new Date();
  if (now < payDayTriggerDate) {
    return 'Draft';
  }
  if (now < lockDate) {
    return 'Adjustment';
  }
  return 'Locked';
}

function getCachedResult(key) {
  const entry = queryResultCache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  return null;
}

function setCachedResult(key, data) {
  queryResultCache.set(key, { data, expiry: Date.now() + QUERY_CACHE_TTL_MS });
}

function invalidateQueryCacheForTable(tableName) {
  const tablePrefix = `${tableName}:`;
  for (const key of queryResultCache.keys()) {
    if (key.includes(tablePrefix)) {
      queryResultCache.delete(key);
    }
  }
}

function invalidateColumnCacheForTable(schema, table) {
  const key = `${schema}.${table}`;
  columnCache.delete(key);
  primaryKeyCache.delete(key);
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.pdf', 'application/pdf'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

function getProjectRefFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

function readLocalPat() {
  try {
    const raw = readFileSync(path.join(rootDir, 'PAT.md'), 'utf8');
    return raw.match(/sbp_[A-Za-z0-9_]+/)?.[0] || raw.trim().split(/\s+/).find(Boolean) || null;
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) {
      const raw = req.body.toString('utf8');
      return raw ? JSON.parse(raw) : {};
    }
    if (typeof req.body === 'object' && req.body !== null) return req.body;
    return {};
  }

  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// ── Outreach helpers (Brevo + Supabase log) ────────────────────────────────────
// Replaces {{Token}} placeholders. Tokens are case-insensitive and tolerate
// spaces, dashes, and underscores inside the token name.
function renderOutreachTemplate(template, recipient) {
  if (typeof template !== 'string') return '';
  const source = recipient && typeof recipient === 'object' ? recipient : {};
  return template.replace(/\{\{\s*([A-Za-z0-9_\- ]+?)\s*\}\}/g, (_match, rawToken) => {
    const token = String(rawToken).trim().toLowerCase().replace(/[\s_-]+/g, '_');
    if (!token) return '';
    if (Object.prototype.hasOwnProperty.call(source, token)) {
      const value = source[token];
      if (value === null || value === undefined) return '';
      return String(value);
    }
    // Pass-through for common spellings the UI might emit ("Client Name" -> client_name).
    const fallback = String(rawToken).trim();
    if (Object.prototype.hasOwnProperty.call(source, fallback)) {
      const value = source[fallback];
      if (value === null || value === undefined) return '';
      return String(value);
    }
    // Leave the placeholder in place so the operator can spot the missing token.
    return `{{${rawToken}}}`;
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapHtmlBody(previewText, htmlInner) {
  const preview = escapeHtml(previewText || '').replace(/\s+/g, ' ').slice(0, 200);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email</title></head>
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;">
<span style="display:none;max-height:0;overflow:hidden;">${preview}</span>
${htmlInner || ''}
</body></html>`;
}

async function appendDispatchLogRow({ campaignId, recipientEmail, status, messageId = null, error = null, provider = 'brevo' }) {
  try {
    await insertSqlRows({
      schema: 'public',
      table: 'outreach_dispatch_log',
      data: [{
        campaign_id: campaignId || null,
        recipient_email: recipientEmail || null,
        status: status || 'queued',
        provider,
        provider_message_id: messageId,
        error_message: error,
        attempted_at: new Date().toISOString(),
      }],
    });
  } catch (e) {
    console.warn('[outreach] appendDispatchLogRow failed:', e?.message || e);
  }
}

function quoteIdent(identifier) {
  const value = String(identifier || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function assertValidIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${normalized}`);
  }
  return normalized;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ── Customer session cookies ─────────────────────────────────────────────────
//
// The customer portal used to keep its "session" in localStorage, which meant
// anyone with devtools could forge `user_role: 'admin'` and shove it into the
// body of `/api/supabase` requests. We now sign a small JWT into an httpOnly,
// SameSite=Lax, Secure cookie and verify it server-side on every request that
// touches the customer data path (`/api/supabase`).
//
// Cookie shape:
//   espressgo_session=<jwt> ; HttpOnly ; SameSite=Lax ; Secure ; Path=/
//
// JWT payload (HS256, base64url-encoded):
//   {
//     sub:  '<supabase user id>' | null,
//     email,
//     name,
//     company,
//     segment: 'b2c' | 'b2b',
//     role:    'client',
//     iat, exp
//   }
//
// The cookie is *not* the Supabase access token — we don't want the refresh
// token living in a cookie we control. We simply keep enough customer identity
// (id/email/name/segment) to enforce RBAC + filter rows by `customer_email`.

function isPrivateNetworkHost(host) {
    const raw = String(host || '').trim().toLowerCase().split(':')[0];
    if (!raw) return false;
    if (raw === 'localhost' || raw.endsWith('.localhost')) return true;
    // Bare IPv6 forms: ::1, fc00::1, fe80::1, etc.
    if (raw === '::1' || raw === '[::1]') return true;
    if (raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('fe80')) return true; // ULA + link-local
    // IPv4 dotted form
    const m = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (![a, b, Number(m[3]), Number(m[4])].every((n) => n >= 0 && n <= 255)) return false;
    if (a === 127) return true;                                      // 127.0.0.0/8   loopback
    if (a === 10) return true;                                       // 10.0.0.0/8    RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;                // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;                         // 192.168.0.0/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;               // 100.64.0.0/10 Tailscale / CGNAT (RFC6598)
    return false;
}

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'espressgo_session';
// Separate cookie for staff sessions. Kept independent so a leaked staff JWT
// can't be replayed against customer endpoints (and vice versa) — they have
// different payload shapes and are checked by different code paths.
const STAFF_COOKIE_NAME = process.env.STAFF_COOKIE_NAME || 'espressgo_staff_session';
// Allow opting out of Secure for local http:// development. Default is to keep
// Secure on at all times — the right answer for any deployment that touches the
// public internet.
//
// Resolution order:
//   1. Explicit env var (SESSION_COOKIE_SECURE=true|false) — wins always.
//   2. Otherwise, treat the request's host as a "private network" — loopback
//      (localhost / 127.0.0.0/8 / ::1), RFC1918 (10/8, 172.16/12, 192.168/16),
//      Tailscale / CGNAT (100.64/10), or IPv6 ULA/link-local — and skip Secure
//      so plain http:// works on LAN, Tailscale, ngrok-on-LAN, dev tunnels, etc.
//      Browsers refuse to store Secure cookies over plain http://, which
//      silently breaks login otherwise.
//   3. Otherwise (any public host), Secure stays on.
//
// The host is sourced from X-Forwarded-Host first (so this still works when
// the Node process is behind a reverse proxy / tunnel), then Host, then a
// env-configured fallback.
const SESSION_COOKIE_SECURE_EXPLICIT = (() => {
    if (process.env.SESSION_COOKIE_SECURE === undefined) return null;
    const raw = String(process.env.SESSION_COOKIE_SECURE).trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return null;
})();
const SESSION_COOKIE_DETECTED_HOST =
    process.env.HOST ||
    process.env.HRP_HOST ||
    process.env.SESSION_HOST ||
    'localhost';
const SESSION_COOKIE_SECURE = SESSION_COOKIE_SECURE_EXPLICIT !== null
    ? SESSION_COOKIE_SECURE_EXPLICIT
    : !(process.env.NODE_ENV !== 'production' && isPrivateNetworkHost(SESSION_COOKIE_DETECTED_HOST));
const SESSION_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days
// Fallback secret keeps the server bootable in dev, but emit a loud warning so
// nobody accidentally ships a predictable cookie signer to prod.
const DEFAULT_DEV_SECRET = 'espressgo-dev-only-cookie-secret-change-me';
const SESSION_COOKIE_SECRET = process.env.SESSION_COOKIE_SECRET
  || (process.env.NODE_ENV === 'production' ? null : DEFAULT_DEV_SECRET);
if (!SESSION_COOKIE_SECRET) {
  console.warn('[session] SESSION_COOKIE_SECRET is not set — customer portal /api/session/* will return 503');
}
if (SESSION_COOKIE_SECRET === DEFAULT_DEV_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[session] FATAL: refusing to run in production with the dev fallback cookie secret. Set SESSION_COOKIE_SECRET to a strong random value.');
  process.exit(1);
}

function b64urlEncode(value) {
  return Buffer.from(value).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function signSessionJwt(payload) {
  if (!SESSION_COOKIE_SECRET) throw new Error('session secret not configured');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + SESSION_COOKIE_MAX_AGE_S, ...payload };
  const encodedHeader = b64urlEncode(JSON.stringify(header));
  const encodedBody = b64urlEncode(JSON.stringify(body));
  const data = `${encodedHeader}.${encodedBody}`;
  const signature = createHmac('sha256', SESSION_COOKIE_SECRET)
    .update(data)
    .digest();
  return `${data}.${b64urlEncode(signature)}`;
}

function verifySessionJwt(token) {
  if (!SESSION_COOKIE_SECRET || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, encodedSig] = parts;
  const data = `${encodedHeader}.${encodedBody}`;
  const expected = createHmac('sha256', SESSION_COOKIE_SECRET).update(data).digest();
  let provided;
  try {
    provided = b64urlDecode(encodedSig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encodedBody).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
  if (!payload.email || !payload.segment) return null;
  return payload;
}

function parseCookies(req) {
  const raw = req.headers?.cookie;
  if (!raw) return {};
  const out = {};
  for (const piece of String(raw).split(';')) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    const name = piece.slice(0, idx).trim();
    if (!name) continue;
    const value = piece.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function readSessionFromRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionJwt(cookies[SESSION_COOKIE_NAME]);
}

/**
 * Verify that the supplied email actually has the supplied role in
 * public.staff_profiles. Used by the Supabase API RBAC layer to trust a
 * body's user_role/user_email claim — but only when backed by an actual
 * staff_profiles row. Prevents the operator (or anyone) from forging
 * `user_role: 'admin'` to escape the customer-cookie default.
 *
 * @param {string} email
 * @param {string} claimedRole  e.g. 'admin', 'sales', 'accountant'
 * @returns {Promise<boolean>}
 */
async function verifyStaffRole(email, claimedRole) {
  if (!email || !claimedRole) return false;
  if (!supabaseAdmin) return false;
  const ALLOWED = new Set(['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales']);
  if (!ALLOWED.has(String(claimedRole).toLowerCase())) return false;
  try {
    const { data, error } = await supabaseAdmin
      .schema('public')
      .from('staff_profiles')
      .select('role, email, department')
      .ilike('email', String(email).trim())
      .limit(1)
      .maybeSingle();
    if (error || !data) return false;
    return String(data.role || '').toLowerCase() === String(claimedRole).toLowerCase();
  } catch (e) {
    return false;
  }
}

// Resolves the cookie's `Secure` flag for a given request.
//
// Priority:
//   1. Explicit SESSION_COOKIE_SECURE env override (wins always).
//   2. Otherwise, inspect the request's host (X-Forwarded-Host → Host) and
//      drop Secure when it's on a private network (loopback / RFC1918 /
//      Tailscale / ULA / link-local). This is correct for LAN / Tailnet
//      deployments where TLS is terminated upstream or not used at all.
//   3. Otherwise (public host), Secure stays on.
//
// We deliberately do NOT trust X-Forwarded-Host unless we know there's a
// reverse proxy in front. By default we only trust `Host`, which is what
// the browser actually connected to. Set TRUST_PROXY=1 to also honour
// X-Forwarded-Host (and X-Forwarded-Proto, if you add it later) when a
// known reverse proxy is fronting the app.
function shouldUseSecureCookie(req) {
    if (SESSION_COOKIE_SECURE_EXPLICIT !== null) return SESSION_COOKIE_SECURE_EXPLICIT;
    const trustProxy = String(process.env.TRUST_PROXY || '').toLowerCase() === '1'
        || String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
    const headerHost = trustProxy
        ? (req?.headers?.['x-forwarded-host'] || req?.headers?.host || SESSION_COOKIE_DETECTED_HOST)
        : (req?.headers?.host || SESSION_COOKIE_DETECTED_HOST);
    if (process.env.NODE_ENV === 'production') return true;
    return !isPrivateNetworkHost(headerHost);
}

function setSessionCookie(req, res, jwt, { name = SESSION_COOKIE_NAME } = {}) {
  const cookie = [
    `${name}=${encodeURIComponent(jwt)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_S}`,
  ];
  if (shouldUseSecureCookie(req)) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

function clearSessionCookie(req, res, { name = SESSION_COOKIE_NAME } = {}) {
  const cookie = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (shouldUseSecureCookie(req)) cookie.push('Secure');
  res.setHeader('Set-Cookie', cookie.join('; '));
}

async function authenticatePortalRequest(req, res, { allowAnonymous = false } = {}) {
  const session = readSessionFromRequest(req);
  if (!session) {
    if (allowAnonymous) return { session: null };
    sendJson(res, 401, { error: 'Not authenticated', code: 'NO_SESSION' });
    return null;
  }
  return { session };
}

// ── Staff session cookies ─────────────────────────────────────────────────────
//
// Staff identity must come from a server-verified source — localStorage cannot
// be trusted because any caller with devtools can write whatever role they want
// to it. We sign a small JWT into a separate httpOnly cookie and validate it
// against the public.staff_profiles row at login time. After that, the cookie
// alone is sufficient to prove identity on every subsequent request.
//
// Cookie shape:
//   espressgo_staff_session=<jwt> ; HttpOnly ; SameSite=Lax ; Secure ; Path=/
//
// JWT payload (HS256, base64url-encoded):
//   {
//     sub:        '<supabase user id>' | null,
//     email,
//     role:       'admin' | 'accountant' | 'procurement' | 'production' | 'logistic' | 'sales',
//     department: string,
//     staff_id:   staff_profiles.id (uuid) | null,
//     iat, exp
//   }

function readStaffSessionFromRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionJwt(cookies[STAFF_COOKIE_NAME]);
}

/**
 * Look up the staff_profiles row for the given email. Returns null when the
 * user has a Supabase Auth account but no staff profile — which is the
 * "fail closed" case. The login handler converts null into 403.
 *
 * @param {string} email
 * @returns {Promise<{role:string, department:string, staff_id:string} | null>}
 */
async function loadStaffProfile(email) {
  if (!email || !supabaseAdmin) return null;
  const ALLOWED = new Set(['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales']);
  const trimmed = String(email).trim();

  // Primary path: PostgREST via the service-role client. Fast and works in
  // the common case. If the table is missing a GRANT for service_role
  // (e.g. it was created by an admin route that bypassed the usual grant
  // step), PostgREST returns 42501 "permission denied". That's a *schema*
  // problem, not an auth problem, and login should not silently fail as
  // if the user didn't have a profile — so we fall back to the SQL proxy.
  let data = null;
  try {
    const { data: row, error } = await supabaseAdmin
      .schema('public')
      .from('staff_profiles')
      .select('id, role, department, email')
      .ilike('email', trimmed)
      .limit(1)
      .maybeSingle();
    if (!error && row) {
      data = row;
    } else if (error) {
      console.warn(`[loadStaffProfile] PostgREST lookup failed (${error.code || ''} ${error.message}); falling back to SQL proxy`);
      data = await loadStaffProfileViaSqlProxy(trimmed);
    }
  } catch (e) {
    console.warn(`[loadStaffProfile] PostgREST threw; falling back to SQL proxy: ${e.message || e}`);
    data = await loadStaffProfileViaSqlProxy(trimmed);
  }

  if (!data) return null;
  const role = String(data.role || '').toLowerCase();
  if (!ALLOWED.has(role)) return null;
  return {
    role,
    department: String(data.department || ''),
    staff_id: data.id || null,
  };
}

async function loadStaffProfileViaSqlProxy(email) {
  if (!sqlProxyConfigured || sqlProxyDisabled) return null;
  const safe = String(email).replace(/'/g, "''");
  try {
    const result = await executeSqlOperation({
      operation: 'raw',
      query: `SELECT id, role, department, email FROM public.staff_profiles WHERE email ILIKE '${safe}' LIMIT 1`,
    });
    const row = Array.isArray(result) ? result[0] : null;
    return row || null;
  } catch (e) {
    console.warn(`[loadStaffProfile] SQL proxy fallback also failed: ${e.message || e}`);
    return null;
  }
}

function isLikelyJsonbColumn(columnName) {
  const col = String(columnName || '');
  // *_codes / *_items / *_data / *_meta / *_config / *_settings / *_attributes / *_ids /
  // *_records / *_logs / *_history are typically jsonb. Columns starting with items_/data_
  // are also jsonb.
  return /_(?:codes?|items?|data|meta|config|settings|attributes|ids|records|logs|history)$/i.test(col)
    || col.startsWith('items_') || col.startsWith('data_');
}

function sqlValue(value, columnName) {
  if (value === undefined || value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (Array.isArray(value)) {
    if (value.length === 0) return "'[]'";
    const isJsonb = isLikelyJsonbColumn(columnName);
    const isPrimitive = value.every((v) => v === null || v === undefined || typeof v !== 'object');
    if (isJsonb || !isPrimitive) {
      return quoteLiteral(JSON.stringify(value));
    }
    return 'ARRAY[' + value.map((v) => sqlValue(v, columnName)).join(', ') + ']';
  }
  if (typeof value === 'object') return quoteLiteral(JSON.stringify(value));
  return quoteLiteral(value);
}

function resolveSchemaAndTable(schema, table) {
  const tableValue = String(table || '').trim();
  if (tableValue.includes('.')) {
    const [schemaPart, tablePart] = tableValue.split('.');
    return {
      schema: assertValidIdentifier(schemaPart || schema || 'public', 'schema'),
      table: assertValidIdentifier(tablePart, 'table'),
    };
  }

  return {
    schema: assertValidIdentifier(schema || 'public', 'schema'),
    table: assertValidIdentifier(tableValue, 'table'),
  };
}

function qualifiedTable(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function parseSqlRows(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.result)) return body.result;

  const firstResult = body?.results?.[0];
  if (firstResult?.rows && firstResult?.columns) {
    return firstResult.rows.map((row) => {
      const mapped = {};
      firstResult.columns.forEach((column, index) => {
        mapped[column.name || column] = row[index];
      });
      return mapped;
    });
  }

  if (firstResult?.rows && firstResult?.cols) {
    return firstResult.rows.map((row) => {
      const mapped = {};
      firstResult.cols.forEach((column, index) => {
        mapped[column.name || column] = row[index];
      });
      return mapped;
    });
  }

  return [];
}

// ── AI auto-reply (Support Hub) ───────────────────────────────────────────────
// `generateAiStaffReply` is invoked by `POST /api/support/ai-reply/:channelId`
// after every customer message in a chat channel. It enforces the safety gate,
// calls OpenRouter with a strict system prompt + order context, and (on pass)
// inserts the AI reply into chat_messages as a staff message.
//
// Hard rules baked into the gate:
//   1. Refuse-list: messages with refund/cancel/legal/urgent keywords bypass
//      AI and mark the channel `needs_attention` so staff pick it up.
//   2. Cooldown: skip if any staff (including prior AI) replied in the last
//      AI_REPLY_COOLDOWN_MS — staff may already be handling the thread.
//   3. Daily cap: AI_REPLY_DAILY_CAP replies per UTC day, then hard stop.
//   4. Idempotency: never reply twice to the same customer message.
//   5. Audit log: every decision (sent/skipped/handoff) is written to
//      public.chat_ai_log with prompt + reply.
async function generateAiStaffReply({ channelId, customerMessageId, customerMessageText, orderId }) {
  let resolvedOrderId = orderId;
  let customerEmail = null;

  try {
    const q = `SELECT order_id, customer_email FROM public.chat_channels WHERE id = '${channelId}' LIMIT 1`;
    const cData = await runManagementSql(q);
    const cRows = parseSqlRows(cData);
    
    if (cRows && cRows.length > 0) {
      if (!resolvedOrderId) {
        resolvedOrderId = cRows[0].order_id;
      }
      customerEmail = cRows[0].customer_email;
    }
  } catch (err) {
    console.warn('[ai-reply] Failed to fetch channel details:', err);
  }

  if (!resolvedOrderId && customerEmail) {
    try {
      const qRetail = `SELECT purchase_number FROM public.retail_purchases WHERE customer_email = '${customerEmail.replace(/'/g, "''")}' ORDER BY created_at DESC LIMIT 1`;
      const rData = await runManagementSql(qRetail);
      const rRows = parseSqlRows(rData);
      if (rRows && rRows.length > 0) {
        resolvedOrderId = rRows[0].purchase_number;
      } else {
        const qOrder = `SELECT order_number FROM public.orders WHERE customer_email = '${customerEmail.replace(/'/g, "''")}' ORDER BY created_at DESC LIMIT 1`;
        const oData = await runManagementSql(qOrder);
        const oRows = parseSqlRows(oData);
        if (oRows && oRows.length > 0) {
          resolvedOrderId = oRows[0].order_number;
        }
      }
    } catch (err) {
      console.warn('[ai-reply] Failed to fetch latest order for customer:', err);
    }
  }

  orderId = resolvedOrderId;

  // 1. Refuse-list — high-stakes keywords. AI must not reply.
  const refuseKeywords = [
    /\brefund\b/i, /\bcancel\b/i, /\bchargeback\b/i, /\blawsuit\b/i,
    /\blegal\b/i, /\bsue\b/i, /\bscam\b/i, /\bfraud\b/i,
    /\burgent\b/i, /\bemergency\b/i, /\bcomplaint\b/i,
    /\bmanager\b/i, /\bsupervisor\b/i, /\bcompensation\b/i,
  ];
  const isRefused = refuseKeywords.some((re) => re.test(customerMessageText));

  if (isRefused) {
    await logAiDecision({
      channelId, orderId, customerMessageId, customerMessageText,
      promptText: null, replyText: null,
      gateDecision: 'handoff', gateReason: 'refuse_keyword',
    });
    await markChannelNeedsAttention(channelId, 'refuse_keyword');
    return { sent: false, reason: 'refuse_keyword' };
  }

  // 2. Cooldown — was a staff message posted in this channel within cooldown?
  const cooldownThreshold = new Date(Date.now() - AI_REPLY_COOLDOWN_MS).toISOString();
  const { data: recentStaff } = await supabaseAdmin
    .from('chat_messages')
    .select('id, created_at, sender_role')
    .eq('channel_id', channelId)
    .eq('is_staff', true)
    .gte('created_at', cooldownThreshold)
    .order('created_at', { ascending: false })
    .limit(1);

  if (recentStaff && recentStaff.length > 0) {
    await logAiDecision({
      channelId, orderId, customerMessageId, customerMessageText,
      promptText: null, replyText: null,
      gateDecision: 'skipped', gateReason: 'staff_recently_replied',
      metadata: { last_staff_at: recentStaff[0].created_at },
    });
    return { sent: false, reason: 'staff_recently_replied' };
  }

  // 3. Daily cap — count today's AI replies
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: todayCount } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('is_ai', true)
    .gte('created_at', startOfDay.toISOString());

  if ((todayCount || 0) >= AI_REPLY_DAILY_CAP) {
    await logAiDecision({
      channelId, orderId, customerMessageId, customerMessageText,
      promptText: null, replyText: null,
      gateDecision: 'skipped', gateReason: 'daily_cap',
      metadata: { cap: AI_REPLY_DAILY_CAP, today: todayCount },
    });
    await markChannelNeedsAttention(channelId, 'daily_cap');
    return { sent: false, reason: 'daily_cap' };
  }

  // 4. Idempotency — already replied to this exact customer message?
  const { data: existing } = await supabaseAdmin
    .from('chat_messages')
    .select('id')
    .eq('channel_id', channelId)
    .eq('is_ai', true)
    .eq('ai_reply_to', customerMessageId)
    .limit(1);

  if (existing && existing.length > 0) {
    return { sent: false, reason: 'already_replied' };
  }

  // 5. Build context — fetch order + recent chat
  const orderContext = await fetchOrderContext(orderId);
  const { data: recent } = await supabaseAdmin
    .from('chat_messages')
    .select('sender_id, sender_name, message_text, created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(8);

  const recentHistory = (recent || [])
    .slice()
    .reverse()
    .map((m) => `[${m.sender_id}] ${m.sender_name}: ${m.message_text}`)
    .join('\n');

  const systemPrompt = [
    'You are an Espressgo customer support assistant replying to a customer about their order.',
    'Strict rules you MUST follow:',
    '  - Only state facts you can verify from the order context below.',
    '  - NEVER promise a refund, cancellation, credit, or any monetary action.',
    '  - NEVER claim an order has been shipped, refunded, or processed unless the order status explicitly shows it.',
    '  - NEVER invent order numbers, prices, dates, or policies.',
    '  - If the customer is angry, asks for a refund, mentions legal action, or has a question you cannot answer from the context, reply with a polite handoff: "I\'ll have a colleague from our support team follow up with you shortly on this." and stop.',
    '  - Keep replies under 60 words, friendly, professional, and in plain English.',
    '  - Do not mention that you are an AI.',
    '  - Do not use marketing language. No emojis.',
    '  - Output ONLY the final response message to the customer. DO NOT think out loud, outline rules, draft potential replies, or explain your reasoning.',
  ].join('\n');

  const userPrompt = [
    orderContext ? `Order context:\n${orderContext}\n` : 'Order context: not available.\n',
    `Recent conversation:\n${recentHistory || '(no prior messages)'}\n`,
    `Latest customer message:\n${customerMessageText}`,
    '\nDirect customer reply (only output the final message itself):',
  ].join('\n');

  // 6. Call OpenRouter
  let rawReply;
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://espressgo.local',
        'X-Title': 'Espressgo Support AI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 220,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`OpenRouter ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    rawReply = String(data?.choices?.[0]?.message?.content || '').trim();
  } catch (apiErr) {
    await logAiDecision({
      channelId, orderId, customerMessageId, customerMessageText,
      promptText: userPrompt, replyText: null,
      gateDecision: 'skipped', gateReason: `openrouter_error: ${apiErr.message}`,
    });
    return { sent: false, reason: 'openrouter_error' };
  }

  if (!rawReply) {
    await logAiDecision({
      channelId, orderId, customerMessageId, customerMessageText,
      promptText: userPrompt, replyText: null,
      gateDecision: 'skipped', gateReason: 'empty_reply',
    });
    return { sent: false, reason: 'empty_reply' };
  }

  // 7. Post-process — strip any quotes the model wrapped around the reply,
  //    and clamp to a single paragraph.
  let cleanReply = rawReply
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  // Safeguard: if handoff phrase is detected in any form, return the exact handoff string
  if (cleanReply.toLowerCase().includes('colleague from our support team') || 
      cleanReply.toLowerCase().includes('follow up with you shortly')) {
    cleanReply = "I'll have a colleague from our support team follow up with you shortly on this.";
  }

  // 8. Insert into chat_messages as a staff message. The customer sees this
  //    as a normal staff reply; the Support Hub renders an "AI" badge via
  //    the `is_ai` + `ai_reply_to` columns.
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('chat_messages')
    .insert({
      channel_id: channelId,
      sender_name: 'Espressgo Support',
      sender_role: 'staff',
      is_staff: true,
      is_customer: false,
      is_system: false,
      is_ai: true,
      ai_reply_to: customerMessageId,
      message_type: 'message',
      message_text: cleanReply,
    })
    .select('id')
    .single();

  if (insertErr) {
    await logAiDecision({
      channelId, orderId, customerMessageId, customerMessageText,
      promptText: userPrompt, replyText: cleanReply,
      gateDecision: 'skipped', gateReason: `insert_error: ${insertErr.message}`,
    });
    return { sent: false, reason: 'insert_error' };
  }

  // 9. Touch channel last_message_at so the Support Hub sorts correctly.
  try {
    await supabaseAdmin
      .from('chat_channels')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', channelId);
  } catch (_) { /* best-effort */ }

  await logAiDecision({
    channelId, orderId, customerMessageId, customerMessageText,
    promptText: userPrompt, replyText: cleanReply,
    gateDecision: 'sent', gateReason: 'ok',
    metadata: { message_id: inserted?.id, model: OPENROUTER_MODEL },
  });

  return { sent: true, messageId: inserted?.id, reply: cleanReply };
}

async function fetchOrderContext(orderId) {
  if (!orderId) return null;
  const safeId = String(orderId).trim().replace(/'/g, "''");

  // 1. Try B2C: retail_purchases
  try {
    const query = `
      SELECT id, purchase_number, status, total_amount, created_at, notes, product, customer_name, customer_email 
      FROM public.retail_purchases 
      WHERE purchase_number ILIKE '${safeId}' OR id::text = '${safeId}'
      LIMIT 1
    `;
    const b2cData = await runManagementSql(query);
    const rows = parseSqlRows(b2cData);

    if (rows && rows.length > 0) {
      const o = rows[0];
      const items = o.notes || o.product || 'Retail order';
      
      let fulfillmentStatus = 'Not created';
      try {
        const fQuery = `
          SELECT status FROM public.fulfillment_orders 
          WHERE purchase_id = '${o.id}' OR purchase_id = '${o.purchase_number}'
          LIMIT 1
        `;
        const fData = await runManagementSql(fQuery);
        const fRows = parseSqlRows(fData);
        if (fRows && fRows.length > 0) {
          fulfillmentStatus = fRows[0].status;
        }
      } catch (err) {
        console.warn(`[fetchOrderContext] B2C fulfillment lookup failed:`, err);
      }

      return [
        `Order ID: ${o.purchase_number || o.id}`,
        `Client Segment: B2C (Retail)`,
        `Customer: ${o.customer_name || 'N/A'} (${o.customer_email || 'N/A'})`,
        `Ordered Items: ${items}`,
        `Order Status: ${o.status || 'unknown'}`,
        `Fulfillment Status: ${fulfillmentStatus}`,
        o.total_amount ? `Total Amount: $${o.total_amount}` : null,
        o.created_at ? `Date: ${o.created_at}` : null,
      ].filter(Boolean).join('\n');
    }
  } catch (err) {
    console.warn(`[fetchOrderContext] B2C lookup failed:`, err);
  }

  // 2. Try B2B: orders
  try {
    const query = `
      SELECT id, order_number, status, total_amount, created_at, notes, customer_name, customer_email, company_name 
      FROM public.orders 
      WHERE order_number ILIKE '${safeId}' OR id::text = '${safeId}'
      LIMIT 1
    `;
    const b2bData = await runManagementSql(query);
    const rows = parseSqlRows(b2bData);

    if (rows && rows.length > 0) {
      const o = rows[0];
      const items = o.notes || 'B2B order';
      
      let fulfillmentStatus = 'Not created';
      try {
        const fQuery = `
          SELECT status FROM public.fulfillment_orders 
          WHERE order_id = '${o.id}' OR order_id = '${o.order_number}'
          LIMIT 1
        `;
        const fData = await runManagementSql(fQuery);
        const fRows = parseSqlRows(fData);
        if (fRows && fRows.length > 0) {
          fulfillmentStatus = fRows[0].status;
        }
      } catch (err) {
        console.warn(`[fetchOrderContext] B2B fulfillment lookup failed:`, err);
      }

      return [
        `Order ID: ${o.order_number || o.id}`,
        `Client Segment: B2B (Wholesale)`,
        `Company: ${o.company_name || 'N/A'}`,
        `Customer: ${o.customer_name || 'N/A'} (${o.customer_email || 'N/A'})`,
        `Ordered Items: ${items}`,
        `Order Status: ${o.status || 'unknown'}`,
        `Fulfillment Status: ${fulfillmentStatus}`,
        o.total_amount ? `Total Amount: $${o.total_amount}` : null,
        o.created_at ? `Date: ${o.created_at}` : null,
      ].filter(Boolean).join('\n');
    }
  } catch (err) {
    console.warn(`[fetchOrderContext] B2B lookup failed:`, err);
  }

  // 3. Try Direct Fulfillment
  try {
    const query = `
      SELECT id, fulfillment_code, status, order_date, notes, customer_name, total_amount 
      FROM public.fulfillment_orders 
      WHERE fulfillment_code ILIKE '${safeId}' OR id::text = '${safeId}' OR fulfillment_id ILIKE '${safeId}'
      LIMIT 1
    `;
    const fData = await runManagementSql(query);
    const rows = parseSqlRows(fData);

    if (rows && rows.length > 0) {
      const o = rows[0];
      return [
        `Fulfillment ID: ${o.fulfillment_code || o.id}`,
        `Customer: ${o.customer_name || 'N/A'}`,
        `Ordered Items: ${o.notes || 'N/A'}`,
        `Fulfillment Status: ${o.status || 'unknown'}`,
        o.total_amount ? `Total Amount: $${o.total_amount}` : null,
        o.order_date ? `Order Date: ${o.order_date}` : null,
      ].filter(Boolean).join('\n');
    }
  } catch (err) {
    console.warn(`[fetchOrderContext] Direct fulfillment lookup failed:`, err);
  }

  return null;
}

async function markChannelNeedsAttention(channelId, reason) {
  if (!channelId) return;
  try {
    await supabaseAdmin
      .from('chat_channels')
      .update({
        metadata: { needs_attention: true, needs_attention_reason: reason, needs_attention_at: new Date().toISOString() },
      })
      .eq('id', channelId);
  } catch (e) {
    console.warn('[ai-reply] markChannelNeedsAttention failed:', e?.message || e);
  }
}

async function logAiDecision(entry) {
  try {
    await supabaseAdmin.from('chat_ai_log').insert({
      channel_id: entry.channelId,
      order_id: entry.orderId,
      customer_message_id: entry.customerMessageId,
      customer_message_text: entry.customerMessageText,
      model: OPENROUTER_MODEL,
      prompt_text: entry.promptText,
      reply_text: entry.replyText,
      gate_decision: entry.gateDecision,
      gate_reason: entry.gateReason,
      metadata: entry.metadata || null,
    });
  } catch (e) {
    console.warn('[ai-reply] logAiDecision failed:', e?.message || e);
  }
}

async function runManagementSql(query) {
  if (!sqlProxyConfigured || sqlProxyDisabled) {
    throw new Error('SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN/SUPABASE_PAT are required for SQL proxy operations');
  }

  let lastError = null;
  const maxAttempts = 2; // Reduced from 5 for faster fail-over

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let resp = null;
    let text = '';
    let body = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

      resp = await fetch(`https://api.supabase.com/v1/projects/${supabaseProjectRef}/database/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${supabaseManagementToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
        agent: httpsAgent, // Use keep-alive agent
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      text = await resp.text();
      body = text;
    } catch (error) {
      lastError = error;
    }

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Keep the raw text in the error message below.
    }

    if (resp?.ok) return body;

    const message =
      body?.message ||
      body?.error ||
      body?.hint ||
      (typeof body === 'string' ? body : JSON.stringify(body));
    if (resp) lastError = new Error(`Supabase SQL ${resp.status}: ${message}`);

    if (resp && (resp.status === 401 || resp.status === 403)) {
      sqlProxyDisabled = true;
      throw lastError; // Fast fail on auth errors
    }

    // Fast fail on non-transient errors (4xx except 429)
    const isTransient = !resp || resp.status === 429 || resp.status >= 500;
    if (!isTransient || attempt === maxAttempts - 1) break;

    const retryAfter = resp ? Number(resp.headers.get('retry-after')) : 0;
    // Fast exponential backoff: 100ms, 200ms (capped)
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(100 * Math.pow(2, attempt), 500);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError;
}

async function getTableColumns(schema, table, options = {}) {
  const cacheKey = `${schema}.${table}`;
  const now = Date.now();

  // Bypass cache entirely when noCache is requested
  if (!options.refresh && !options.noCache && columnCache.has(cacheKey)) {
    const entry = columnCache.get(cacheKey);

    // Fresh cache: return immediately
    if (now < entry.staleTime) {
      return entry.data;
    }

    // Stale but not currently fetching: refresh in background, return stale immediately
    if (!entry.fetching) {
      entry.fetching = true;
      // Fire-and-forget background refresh
      runManagementSql(`
        select column_name
        from information_schema.columns
        where table_schema = ${sqlValue(schema)}
          and table_name = ${sqlValue(table)}
        order by ordinal_position
      `).then((rows) => {
        const columns = new Set(parseSqlRows(rows).map((row) => row.column_name).filter(Boolean));
        columnCache.set(cacheKey, { data: columns, staleTime: now + CACHE_TTL_MS, fetching: false });
      }).catch(() => {
        // On error, clear fetching flag so next request can retry
        if (columnCache.has(cacheKey)) {
          columnCache.get(cacheKey).fetching = false;
        }
      });
      return entry.data; // Return stale data immediately
    }

    // Currently being fetched by another request: return stale while waiting
    return entry.data;
  }

  // No cache or force refresh: fetch and cache
  const rows = parseSqlRows(await runManagementSql(`
    select column_name
    from information_schema.columns
    where table_schema = ${sqlValue(schema)}
      and table_name = ${sqlValue(table)}
    order by ordinal_position
  `));

  const columns = new Set(rows.map((row) => row.column_name).filter(Boolean));
  if (!options.noCache && (columns.size > 0 || !options.skipEmptyCache)) {
    columnCache.set(cacheKey, { data: columns, staleTime: now + CACHE_TTL_MS, fetching: false });
  }
  return columns;
}

async function ensureTableColumns(schema, table, options = {}) {
  const cached = await getTableColumns(schema, table, { skipEmptyCache: true, noCache: options.noCache });
  if (cached.size > 0) return cached;
  return getTableColumns(schema, table, { refresh: true, skipEmptyCache: true, noCache: options.noCache });
}

async function getPrimaryKeyColumns(schema, table) {
  const cacheKey = `${schema}.${table}`;
  const now = Date.now();

  // Check cache with stale-while-revalidate
  if (primaryKeyCache.has(cacheKey)) {
    const entry = primaryKeyCache.get(cacheKey);

    // Fresh cache: return immediately
    if (now < entry.staleTime) {
      return entry.data;
    }

    // Stale but not currently fetching: refresh in background, return stale immediately
    if (!entry.fetching) {
      entry.fetching = true;
      // Fire-and-forget background refresh
      runManagementSql(`
        select kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on tc.constraint_name = kcu.constraint_name
         and tc.table_schema = kcu.table_schema
         and tc.table_name = kcu.table_name
        where tc.constraint_type = 'PRIMARY KEY'
          and tc.table_schema = ${sqlValue(schema)}
          and tc.table_name = ${sqlValue(table)}
        order by kcu.ordinal_position
      `).then((rows) => {
        const columns = parseSqlRows(rows).map((row) => row.column_name).filter(Boolean);
        primaryKeyCache.set(cacheKey, { data: columns, staleTime: now + CACHE_TTL_MS, fetching: false });
      }).catch(() => {
        if (primaryKeyCache.has(cacheKey)) {
          primaryKeyCache.get(cacheKey).fetching = false;
        }
      });
      return entry.data; // Return stale data immediately
    }

    // Currently being fetched by another request: return stale while waiting
    return entry.data;
  }

  // No cache: fetch and cache
  const rows = parseSqlRows(await runManagementSql(`
    select kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema = kcu.table_schema
     and tc.table_name = kcu.table_name
    where tc.constraint_type = 'PRIMARY KEY'
      and tc.table_schema = ${sqlValue(schema)}
      and tc.table_name = ${sqlValue(table)}
    order by kcu.ordinal_position
  `));

  const columns = rows.map((row) => row.column_name).filter(Boolean);
  primaryKeyCache.set(cacheKey, { data: columns, staleTime: now + CACHE_TTL_MS, fetching: false });
  return columns;
}

function sanitizePayload(table, payload) {
  if (!payload || typeof payload !== 'object') return payload;

  if (payload.payment_status === 'Pending approval') {
    payload = { ...payload, payment_status: 'Pending' };
  }

  if (table === 'alerts') {
    return {
      title: payload.title || payload.action || payload.action_type || `${payload.alert_type || 'ERP'} Alert`,
      message: payload.message || payload.description || '',
      alert_type: ['info', 'warning', 'error', 'success'].includes(payload.alert_type) ? payload.alert_type : 'info',
      is_read: Boolean(payload.is_read),
    };
  }

  if (table === 'audit_logs') {
    return {
      user_email: payload.user_email || payload.actor_name || 'local-erp@espressgo.local',
      user_role: payload.user_role || payload.actor_role || 'dev',
      action: payload.action || payload.action_type || payload.event_type || 'DATABASE_OPERATION',
      table_affected: payload.table_affected || payload.entity_type || null,
      record_id: payload.record_id || payload.entity_id || null,
      description: payload.description || payload.message || 'Local ERP database event',
      new_value: payload.new_value || payload.diff || payload,
    };
  }

  return payload;
}

function sanitizeData(table, data) {
  if (Array.isArray(data)) return data.map((row) => sanitizePayload(table, row));
  return sanitizePayload(table, data);
}

function cleanMutationRow(row, validColumns) {
  if (!row || typeof row !== 'object') return {};

  const cleaned = {};
  Object.entries(row).forEach(([key, value]) => {
    if (value === undefined) return;
    if (validColumns.size > 0 && !validColumns.has(key)) return;
    // Defensive: if the table has an `id` column and the caller sent a value
    // that isn't a valid UUID, drop it. The Postgres-side default
    // (gen_random_uuid() on most tables) will fill it in. This protects
    // against clients (e.g. customer-portal chat) that send optimistic
    // client-generated ids like "local-1783…" instead of letting the server
    // mint a UUID. Without this guard the insert fails with
    // "22P02 invalid input syntax for type uuid".
    if (key === 'id' && typeof value === 'string' && !isValidUuid(value)) return;
    cleaned[key] = value;
  });

  return cleaned;
}

// RFC 4122 UUID validator (any version). Matches the canonical 8-4-4-4-12
// hex form Postgres' uuid type accepts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function normalizeRows(data) {
  if (data === undefined || data === null) return [];
  return Array.isArray(data) ? data : [data];
}

function columnsToSql(columns, validColumns) {
  const requested = String(columns || '*').trim();
  if (!requested || requested === '*' || requested === 'representation' || requested === 'minimal') return '*';
  if (requested.includes('(') || requested.includes(')')) return '*';

  const selected = requested
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean)
    .filter((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
    .filter((column) => validColumns.size === 0 || validColumns.has(column))
    .map(quoteIdent);

  return selected.length > 0 ? selected.join(', ') : '*';
}

function addCondition(conditions, validColumns, column, sqlExpression) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) return;
  if (validColumns.size > 0 && !validColumns.has(column)) return;
  conditions.push(`${quoteIdent(column)} ${sqlExpression}`);
}

function buildWhere(filters = {}, validColumns = new Set()) {
  const conditions = [];

  Object.entries(filters.eq || {}).forEach(([column, value]) => {
    if (value === undefined) return;
    addCondition(conditions, validColumns, column, value === null ? 'IS NULL' : `= ${sqlValue(value)}`);
  });

  Object.entries(filters.neq || {}).forEach(([column, value]) => {
    if (value === undefined) return;
    addCondition(conditions, validColumns, column, value === null ? 'IS NOT NULL' : `<> ${sqlValue(value)}`);
  });

  const operatorMap = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    like: 'LIKE',
    ilike: 'ILIKE',
  };

  Object.entries(operatorMap).forEach(([operator, sqlOperator]) => {
    Object.entries(filters[operator] || {}).forEach(([column, value]) => {
      if (value === undefined || value === null) return;
      addCondition(conditions, validColumns, column, `${sqlOperator} ${sqlValue(value)}`);
    });
  });

  Object.entries(filters.in || {}).forEach(([column, value]) => {
    if (!Array.isArray(value) || value.length === 0) return;
    addCondition(conditions, validColumns, column, `IN (${value.map(sqlValue).join(', ')})`);
  });

  // Support `filters.where: [{column, operator, value}]` format used throughout the codebase.
  // Map a small set of operator aliases to SQL fragments; default to '=' when omitted.
  if (Array.isArray(filters.where)) {
    const whereOpMap = {
      eq: '=',
      neq: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      like: 'LIKE',
      ilike: 'ILIKE',
      in: 'IN',
      is: 'IS',
      ne: 'IS NOT',
    };
    for (const cond of filters.where) {
      if (!cond || typeof cond !== 'object') continue;
      const { column, operator = 'eq', value } = cond;
      if (!column) continue;
      let sqlOp = whereOpMap[String(operator).toLowerCase()] || '=';
      let expr;
      if (sqlOp === 'IN') {
        if (!Array.isArray(value) || value.length === 0) continue;
        expr = `IN (${value.map(sqlValue).join(', ')})`;
      } else if (sqlOp === 'IS' || sqlOp === 'IS NOT') {
        expr = `${sqlOp} ${value === null ? 'NULL' : sqlValue(value)}`;
      } else if (value === null) {
        continue; // skip null comparisons for non-IS operators
      } else {
        expr = `${sqlOp} ${sqlValue(value)}`;
      }
      addCondition(conditions, validColumns, column, expr);
    }
  }

  return conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
}

function buildOrderAndLimit(filters = {}, data = {}, validColumns = new Set()) {
  const clauses = [];
  const order = filters.order || filters.sort || data?.order;
  if (order?.column && /^[A-Za-z_][A-Za-z0-9_]*$/.test(order.column)) {
    if (validColumns.size === 0 || validColumns.has(order.column)) {
      clauses.push(` ORDER BY ${quoteIdent(order.column)} ${order.ascending === false ? 'DESC' : 'ASC'}`);
    }
  }

  const limit = filters.limit ?? data?.limit;
  if (limit !== undefined && Number.isFinite(Number(limit))) {
    clauses.push(` LIMIT ${Math.max(0, Number(limit))}`);
  }

  return clauses.join('');
}

function isNonFatalReadError(error) {
  const message = error?.message || String(error || '');
  return /does not exist|column .* does not exist|relation .* does not exist|permission denied (for|on) (table|view|function|schema)/i.test(message);
}

function assertSafeRawQuery(query) {
  const sql = String(query || '').trim();
  if (!sql) throw new Error('query is required for raw operations');
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('raw operations only allow SELECT queries');
  }

  const withoutTrailingSemi = sql.endsWith(';') ? sql.slice(0, -1) : sql;
  if (withoutTrailingSemi.includes(';')) {
    throw new Error('raw operations only allow one SQL statement');
  }

  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|copy|vacuum|analyze)\b/i.test(withoutTrailingSemi)) {
    throw new Error('raw operations only allow read-only SELECT queries');
  }

  return withoutTrailingSemi;
}

async function selectSql({ schema, table, columns, filters, data, noCache }) {
  const validColumns = await ensureTableColumns(schema, table, { noCache });
  if (validColumns.size === 0 && !noCache) return [];

  const query = [
    `SELECT ${columnsToSql(columns, validColumns)} FROM ${qualifiedTable(schema, table)}`,
    buildWhere(filters, validColumns),
    buildOrderAndLimit(filters, data, validColumns),
  ].join('');

  // Generate cache key from query
  const cacheKey = `${table}:${schema}:${query}`;
  if (!noCache) {
    const cached = getCachedResult(cacheKey);
    if (cached) return cached;
  }

  const result = parseSqlRows(await runManagementSql(query));
  if (table === 'batch_trace_view') {
    console.log(`[batch_trace_view SQL] rows=${Array.isArray(result) ? result.length : 'N/A'} query=${query.slice(0, 200)}`);
  }
  if (!noCache) {
    setCachedResult(cacheKey, result);
  }
  return result;
}

async function insertSqlRows({ schema, table, data, returning = '*', noCache = false }) {
  const validColumns = await ensureTableColumns(schema, table, { noCache });
  const rows = normalizeRows(sanitizeData(table, data));
  const returnColumns = columnsToSql(returning, validColumns);

  let cleanedRows;
  if (validColumns.size > 0) {
    cleanedRows = rows.map((r) => cleanMutationRow(r, validColumns)).filter((r) => Object.keys(r).length > 0);
  } else {
    cleanedRows = rows.filter((r) => typeof r === 'object' && r !== null);
  }
  if (cleanedRows.length === 0) return [];

  let sqlResult;
  let sql;
  if (cleanedRows.length === 1) {
    const row = cleanedRows[0];
    const keys = Object.keys(row);
    sql = keys.length > 0
      ? `INSERT INTO ${qualifiedTable(schema, table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map((key) => sqlValue(row[key], key)).join(', ')}) RETURNING ${returnColumns}`
      : `INSERT INTO ${qualifiedTable(schema, table)} DEFAULT VALUES RETURNING ${returnColumns}`;
    const rawResult = await runManagementSql(sql);

    // runManagementSql returns { message, ... } on HTTP 400 errors (constraint violations, etc.)
    // Unlike SELECT which returns [] on errors, INSERT failures must be surfaced as real errors.
    const mgmtError = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult) && rawResult.message;
    if (mgmtError) {
      throw new Error(`INSERT ${schema}.${table} failed: ${rawResult.message}`);
    }

    // Supabase Management API returns a plain JSON array on success (201 Created).
    // For constraint violations / server errors it returns { message: "..." } with HTTP 400.
    // We already threw on mgmtError above. Here we handle the success path.
    if (!rawResult || (Array.isArray(rawResult) && rawResult.length === 0)) {
      throw new Error(`INSERT ${schema}.${table} returned empty result — insert may have been silently rejected`);
    }

    return parseSqlRows(rawResult);
  }

  const keys = Object.keys(cleanedRows[0]);
  const valuesClause = cleanedRows
    .map((row) => `(${keys.map((key) => sqlValue(row[key], key)).join(', ')})`)
    .join(', ');

  sql = `INSERT INTO ${qualifiedTable(schema, table)} (${keys.map(quoteIdent).join(', ')}) VALUES ${valuesClause} RETURNING ${returnColumns}`;
  sqlResult = await runManagementSql(sql);

  const mgmtError = sqlResult && typeof sqlResult === 'object' && !Array.isArray(sqlResult) && sqlResult.message;
  if (mgmtError) {
    throw new Error(`INSERT ${schema}.${table} failed: ${sqlResult.message}`);
  }
  if (!sqlResult || (Array.isArray(sqlResult) && sqlResult.length === 0)) {
    throw new Error(`INSERT ${schema}.${table} returned empty result`);
  }

  return parseSqlRows(sqlResult);
}

function normalizeConflictColumns(onConflict, primaryKeys, row) {
  const explicit = typeof onConflict === 'string'
    ? onConflict.split(',').map((column) => column.trim()).filter(Boolean)
    : Array.isArray(onConflict) ? onConflict : [];
  const candidates = explicit.length > 0 ? explicit : primaryKeys;

  return candidates
    .filter((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column))
    .filter((column) => Object.prototype.hasOwnProperty.call(row, column));
}

async function upsertSqlRows({ schema, table, data, returning = '*', onConflict, noCache = false }) {
  const validColumns = await ensureTableColumns(schema, table, { noCache });

  const primaryKeys = await getPrimaryKeyColumns(schema, table);
  const rows = normalizeRows(sanitizeData(table, data));
  const returnColumns = columnsToSql(returning, validColumns);

  let cleanedRows;
  if (validColumns.size > 0) {
    cleanedRows = rows.map((r) => cleanMutationRow(r, validColumns)).filter((r) => Object.keys(r).length > 0);
  } else {
    cleanedRows = rows.filter((r) => typeof r === 'object' && r !== null);
  }
  if (cleanedRows.length === 0) return [];

  if (cleanedRows.length === 1) {
    // Single row: use original logic for simplicity
    const row = cleanedRows[0];
    const keys = Object.keys(row);
    const conflictColumns = normalizeConflictColumns(onConflict, primaryKeys, row);
    const updateColumns = keys.filter((key) => !conflictColumns.includes(key));
    const conflictSql = conflictColumns.length > 0
      ? ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(', ')}) ${
          updateColumns.length > 0
            ? `DO UPDATE SET ${updateColumns.map((key) => `${quoteIdent(key)} = EXCLUDED.${quoteIdent(key)}`).join(', ')}`
            : 'DO NOTHING'
        }`
      : '';
    const sql = `INSERT INTO ${qualifiedTable(schema, table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map((key) => sqlValue(row[key], key)).join(', ')})${conflictSql} RETURNING ${returnColumns}`;
    return parseSqlRows(await runManagementSql(sql));
  }

  // Batch: determine columns from first row, use first row's conflict columns
  const keys = Object.keys(cleanedRows[0]);
  const firstRowConflict = normalizeConflictColumns(onConflict, primaryKeys, cleanedRows[0]);
  const updateColumns = keys.filter((key) => !firstRowConflict.includes(key));
  const conflictSql = firstRowConflict.length > 0
    ? ` ON CONFLICT (${firstRowConflict.map(quoteIdent).join(', ')}) ${
        updateColumns.length > 0
          ? `DO UPDATE SET ${updateColumns.map((key) => `${quoteIdent(key)} = EXCLUDED.${quoteIdent(key)}`).join(', ')}`
          : 'DO NOTHING'
      }`
    : '';

  const valuesClause = cleanedRows
    .map((row) => `(${keys.map((key) => sqlValue(row[key], key)).join(', ')})`)
    .join(', ');

  const sql = `INSERT INTO ${qualifiedTable(schema, table)} (${keys.map(quoteIdent).join(', ')}) VALUES ${valuesClause}${conflictSql} RETURNING ${returnColumns}`;
  return parseSqlRows(await runManagementSql(sql));
}

async function updateSql({ schema, table, data, filters, returning = '*', noCache = false }) {
  const validColumns = await ensureTableColumns(schema, table, { noCache });
  const sourceRow = Array.isArray(data) ? data[0] : data;

  let row, keys;
  if (validColumns.size > 0) {
    // Normal path: validate against known column set
    row = cleanMutationRow(sanitizeData(table, sourceRow), validColumns);
    keys = Object.keys(row);
  } else {
    // Fallback: allow all source row keys when column introspection is unavailable
    row = sanitizeData(table, sourceRow);
    keys = Object.keys(row).filter((k) => row[k] !== undefined);
  }

  if (keys.length === 0) throw new Error(`No valid columns supplied for ${schema}.${table}`);

  const where = buildWhere(filters, validColumns);
  if (!where) throw new Error(`Refusing to update ${schema}.${table} without filters`);

  const sql = `UPDATE ${qualifiedTable(schema, table)} SET ${keys.map((key) => `${quoteIdent(key)} = ${sqlValue(row[key], key)}`).join(', ')}${where} RETURNING ${columnsToSql(returning, validColumns)}`;
  return parseSqlRows(await runManagementSql(sql));
}

async function deleteSql({ schema, table, filters, returning = '*', noCache = false }) {
  const validColumns = await ensureTableColumns(schema, table, { noCache });

  const where = buildWhere(filters, validColumns);
  if (!where) throw new Error(`Refusing to delete from ${schema}.${table} without filters`);

  const sql = `DELETE FROM ${qualifiedTable(schema, table)}${where} RETURNING ${columnsToSql(returning, validColumns)}`;
  return parseSqlRows(await runManagementSql(sql));
}

async function executeSqlOperation(body) {
  const { table: requestedTable, operation = 'select', data, filters = {}, columns = '*', returning = '*', schema, query, onConflict } = body;

  if (operation === 'raw') {
    const rawQuery = assertSafeRawQuery(query || data?.query);
    console.log('[executeSqlOperation] raw query:', rawQuery);
    const result = await runManagementSql(rawQuery);
    console.log('[executeSqlOperation] result rows:', Array.isArray(result) ? result.length : 'not array', JSON.stringify(result)?.slice(0, 200));
    const parsed = parseSqlRows(result);
    console.log('[executeSqlOperation] parsed rows:', Array.isArray(parsed) ? parsed.length : 'not array');
    return parsed;
  }

  if (operation === 'ddl') {
    const ddlQuery = String(query || data?.query || '').trim();
    if (!/^(alter|create|drop|truncate|grant|revoke)\b/i.test(ddlQuery)) {
      throw new Error('Only DDL (ALTER, CREATE, DROP, TRUNCATE, GRANT, REVOKE) is allowed');
    }
    if (ddlQuery.includes(';')) {
      throw new Error('Only one statement at a time');
    }
    const result = await runManagementSql(ddlQuery);
    return parseSqlRows(result);
  }

  // Run a raw UPDATE statement (for bulk data fixes)
  if (operation === 'sql_update') {
    const sqlQuery = String(query || data?.query || '').trim();
    if (!/^update\b/i.test(sqlQuery)) {
      throw new Error('sql_update only allows UPDATE statements');
    }
    if (sqlQuery.includes(';')) {
      throw new Error('Only one statement at a time');
    }
    const result = await runManagementSql(sqlQuery);
    return parseSqlRows(result);
  }

  // Internal: clear the column cache for a table (used when DDL changes the schema)
  if (operation === 'cache_clear') {
    const tables = Array.isArray(body.tables) ? body.tables : [];
    tables.forEach((t) => {
      const [tSchema, tTable] = (String(t).includes('.') ? t : `${schema || 'public'}.${t}`).split('.');
      columnCache.delete(`${tSchema}.${tTable}`);
    });
    return { cleared: tables };
  }

  if (!requestedTable) throw new Error('table is required');
  const target = resolveSchemaAndTable(schema, requestedTable);

  if (requestedTable === 'batch_trace_view' && operation === 'select') {
    console.log(`[batch_trace_view] operation=${operation} filters=${JSON.stringify(filters)} columns=${columns}`);
  }

  let result;
  switch (operation) {
    case 'select':
      return selectSql({ ...target, data, filters, columns, noCache: body.noCache });
    case 'insert':
      result = await insertSqlRows({ ...target, data, returning, noCache: body.noCache });
      invalidateQueryCacheForTable(target.table);
      invalidateColumnCacheForTable(target.schema, target.table);
      return result;
    case 'upsert':
      result = await upsertSqlRows({ ...target, data, returning, onConflict, noCache: body.noCache });
      invalidateQueryCacheForTable(target.table);
      invalidateColumnCacheForTable(target.schema, target.table);
      return result;
    case 'update':
      result = await updateSql({ ...target, data, filters, returning, noCache: body.noCache });
      invalidateQueryCacheForTable(target.table);
      invalidateColumnCacheForTable(target.schema, target.table);
      return result;
    case 'delete':
      result = await deleteSql({ ...target, filters, returning, noCache: body.noCache });
      invalidateQueryCacheForTable(target.table);
      invalidateColumnCacheForTable(target.schema, target.table);
      return result;
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
}

// Process single B2B row - parallelizes 4 sequential queries into batch
async function processB2bRow(row) {
  if (!row || typeof row !== 'object') return;

  let payload = row.payload || {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }

  const email = String(row.corporate_email || payload.corporateEmail || payload.email || '').trim().toLowerCase();
  if (!email) return;

  const name = String(payload.repName || payload.name || email.split('@')[0] || 'B2B Customer').trim();
  const companyName = String(payload.companyName || payload.company_name || row.company_name || '').trim();
  const enterpriseId = row.enterprise_id || payload.enterpriseId || payload.enterprise_id || null;

  const customerRow = {
    email,
    name,
    company_name: companyName,
    segment: 'b2b',
    is_active: true,
    verification_status: 'pending',
  };

  if (sqlProxyConfigured) {
    // Parallelize upserts for customer_accounts and b2b_documents
    const [c2sResult, enterpriseResult] = await Promise.all([
      upsertSqlRows({
        schema: 'public',
        table: 'customer_accounts',
        data: customerRow,
        returning: '*',
        onConflict: 'email',
      }),
      enterpriseId ? upsertSqlRows({
        schema: 'public',
        table: 'customer_accounts',
        data: {
          email,
          name,
          company_name: companyName,
          segment: 'b2b',
          account_id: enterpriseId,
          document_status: 'Pending',
          verification_status: 'pending',
          is_active: true,
          // B2B-specific fields (extra columns on customer_accounts)
          phone: payload.repPhone || null,
          address: payload.hqAddress || null,
        },
        returning: '*',
        onConflict: 'email',
      }) : Promise.resolve([]),
    ]);

    // If enterprise, insert/update B2B document record
    if (enterpriseId) {
      const existingStatus = await selectSql({
        schema: 'public',
        table: 'customer_accounts',
        columns: 'id',
        filters: { eq: { email } },
        data: { limit: 1 },
      });

      if (!existingStatus || existingStatus.length === 0) {
        await insertSqlRows({
          schema: 'public',
          table: 'customer_accounts',
          data: {
            email,
            name,
            company_name: companyName,
            segment: 'b2b',
            account_id: enterpriseId,
            document_status: 'Pending',
            verification_status: 'pending',
          },
          returning: '*',
        });
      }
    }

    return { c2sResult, enterpriseResult };
  } else if (supabaseAdmin) {
    // Supabase Admin fallback - parallelize upserts
    const [c2sResult, enterpriseResult] = await Promise.all([
      supabaseAdmin.schema('public').from('customer_accounts').upsert(customerRow, { onConflict: 'email' }),
      enterpriseId ? supabaseAdmin.schema('public').from('customer_accounts').upsert({
        email,
        name,
        company_name: companyName,
        segment: 'b2b',
        account_id: enterpriseId,
        document_status: 'Pending',
        verification_status: 'pending',
        is_active: true,
        phone: payload.repPhone || null,
        address: payload.hqAddress || null,
      }, { onConflict: 'email' }) : Promise.resolve({ error: null }),
    ]);

    if (c2sResult.error) throw new Error(c2sResult.error.message || c2sResult.error);
    if (enterpriseId && enterpriseResult.error) throw new Error(enterpriseResult.error.message || enterpriseResult.error);

    if (enterpriseId) {
      const { data: existingStatus, error: statusSelectError } = await supabaseAdmin
        .schema('public').from('customer_accounts').select('id').eq('email', email).limit(1);
      if (statusSelectError) throw new Error(statusSelectError.message || statusSelectError);

      if (!existingStatus || existingStatus.length === 0) {
        const { error: statusError } = await supabaseAdmin
          .schema('public').from('customer_accounts').insert({
            email,
            name,
            company_name: companyName,
            segment: 'b2b',
            account_id: enterpriseId,
            document_status: 'Pending',
            verification_status: 'pending',
          });
        if (statusError) throw new Error(statusError.message || statusError);
      }
    }

    return { c2sResult, enterpriseResult };
  }
}

async function ensureB2bIdentityForOnboardingPayload(data) {
  const rows = normalizeRows(data);
  // Process all rows in parallel for better performance
  await Promise.all(rows.map(processB2bRow));
}

function applyFilters(query, filters = {}, data = {}) {
  const eq = filters.eq || {};
  Object.entries(eq).forEach(([column, value]) => {
    if (value === undefined) return;
    if (value === null) query = query.is(column, null);
    else query = query.eq(column, value);
  });

  const operators = ['neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
  operators.forEach((operator) => {
    const values = filters[operator] || {};
    Object.entries(values).forEach(([column, value]) => {
      if (value === undefined || value === null) return;
      query = query[operator](column, value);
    });
  });

  const inFilters = filters.in || {};
  Object.entries(inFilters).forEach(([column, value]) => {
    if (Array.isArray(value)) query = query.in(column, value);
  });

  const order = filters.order || filters.sort || data?.order;
  if (order?.column) {
    query = query.order(order.column, { ascending: order.ascending !== false });
  }

  const limit = filters.limit || data?.limit;
  if (Number.isFinite(Number(limit))) {
    query = query.limit(Number(limit));
  }

  return query;
}

function normalizeSupabaseResult(result) {
  if (!result?.error) return result;

  const message = result.error.message || '';
  const code = result.error.code;
  const nonFatalPatterns = [
    /Could not find the table/i,
    /permission denied for view/i,
    /does not exist/i,
    /column .* does not exist/i,
  ];

  if (code === '42P01' || code === '42703' || nonFatalPatterns.some((pattern) => pattern.test(message))) {
    return { data: [], error: null };
  }

  return result;
}

async function executeSupabaseJsFallback(body) {
  if (!supabaseAdmin) {
    throw new Error('Supabase is not configured. Add SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ACCESS_TOKEN to .env');
  }

  const { table, operation = 'select', data, filters, columns = '*', returning = '*' } = body;
  if (!table) throw new Error('table is required');

  let query;
  let result;

  switch (operation) {
    case 'select':
      query = supabaseAdmin.from(table).select(columns || '*');
      result = await applyFilters(query, filters, data);
      break;
    case 'insert':
      query = supabaseAdmin.from(table).insert(sanitizeData(table, data));
      result = await query.select(returning === 'representation' ? '*' : returning || '*');
      break;
    case 'upsert':
      query = supabaseAdmin.from(table).upsert(sanitizeData(table, data));
      result = await query.select(returning === 'representation' ? '*' : returning || '*');
      break;
    case 'update':
      query = supabaseAdmin.from(table).update(sanitizeData(table, data));
      result = await applyFilters(query, filters, data).select(returning === 'representation' ? '*' : returning || '*');
      break;
    case 'delete':
      query = supabaseAdmin.from(table).delete();
      result = await applyFilters(query, filters, data).select(returning === 'representation' ? '*' : returning || '*');
      break;
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }

  result = normalizeSupabaseResult(result);
  if (result.error) throw new Error(result.error.message || result.error);
  return result.data || [];
}

// ─── Action classification ───────────────────────────────────────────────────
// Maps schema+table pairs to semantic action types used by the Alert Center.
const ACTION_TYPE_MAP = {
  // Inventory / stock
  'inventory.items':               'STOCK_UPDATE',
  'inventory.orders':              'ORDER_CREATE',
  'inventory.purchase_orders':     'PO_CREATE',
  'inventory.suppliers':           'SUPPLIER_UPDATE',
  'inventory.stock_adjustments':   'STOCK_ADJUST',
  // Warehouse
  'warehouse.ingredients':         'STOCK_UPDATE',
  'warehouse.finished_goods':      'STOCK_UPDATE',
  'warehouse.stock_movements':     'STOCK_MOVE',
  // Finance / journal
  'journal.entries':               'JOURNAL_CREATE',
  'journal.accounts':              'ACCOUNT_UPDATE',
  // Manufacturing / production
  'production.jobs':               'PRODUCTION_CREATE',
  'production.bom':                'BOM_UPDATE',
  // Staff
  'staff.employees':              'STAFF_UPDATE',
  // Customer / orders
  'customer.orders':               'ORDER_CREATE',
  'customer.payments':             'PAYMENT_RECORD',
  // Logistics / factory
  'factory.bookings':              'BOOKING_CREATE',
  'logistic.shipments':            'SHIPMENT_CREATE',
  'logistic.routes':               'ROUTE_UPDATE',
};

function classifyActionType(schema, table) {
  const key = `${schema}.${table}`;
  if (ACTION_TYPE_MAP[key]) return ACTION_TYPE_MAP[key];
  if (table === 'audit_logs' || table === 'alerts') return 'SYSTEM_INTERNAL';
  if (table.endsWith('_logs')) return 'WARNING_ALERT';
  return null; // no special type — will fall through to raw operation name
}

// ─── Smart description builder ─────────────────────────────────────────────────
function buildAuditDescription({ schema, table, operation, data, resultData, targetId }) {
  const rows = Array.isArray(data) ? data : data ? [data] : [];

  switch (table) {
    case 'ingredients': {
      const row = rows[0] || {};
      if (operation === 'insert') return `Added new ingredient: ${row.name || targetId}`;
      if (operation === 'update') {
        const qty = row.quantity ?? row.current_stock;
        if (qty !== undefined) return `Updated ingredient stock: ${row.name || targetId} → ${qty}`;
        return `Updated ingredient: ${row.name || targetId}`;
      }
      if (operation === 'delete') return `Removed ingredient: ${row.name || targetId}`;
      break;
    }
    case 'purchase_orders': {
      const row = rows[0] || {};
      if (operation === 'insert') return `Created PO #${row.po_number || targetId} for ${row.supplier_name || 'Unknown supplier'}`;
      if (operation === 'update') return `Updated PO #${row.po_number || targetId}`;
      break;
    }
    case 'customer_orders': {
      const row = rows[0] || {};
      if (operation === 'insert') return `New customer order: ${row.order_number || targetId} (${row.status || 'pending'})`;
      if (operation === 'update') return `Updated order ${row.order_number || targetId} → ${row.status || 'status changed'}`;
      break;
    }
    case 'employees': {
      const row = rows[0] || {};
      if (operation === 'insert') return `Added new staff member: ${row.name || row.email || targetId}`;
      if (operation === 'update') return `Updated staff record: ${row.name || row.email || targetId}`;
      if (operation === 'delete') return `Removed staff member: ${row.name || row.email || targetId}`;
      break;
    }
    case 'journal_entries': {
      const row = rows[0] || {};
      if (operation === 'insert') return `Posted journal entry: ${row.narration || row.entry_number || targetId}`;
      break;
    }
    case 'accounts': {
      const row = rows[0] || {};
      if (operation === 'insert') return `Created account: ${row.name || targetId} (${row.code || ''})`;
      if (operation === 'update') return `Updated account: ${row.name || targetId}`;
      break;
    }
    case 'stock_adjustments': {
      const row = rows[0] || {};
      return `Stock adjustment: ${row.reason || targetId} — ${row.variation || ''}`;
    }
    case 'payments': {
      const row = rows[0] || {};
      if (operation === 'insert') return `Recorded payment: ${row.amount || targetId} for ${row.reference || 'order'}`;
      break;
    }
    default: {
      // Generic fallback — never generic: include table and primary key
      const sample = rows[0] || {};
      const idField = sample.id || sample.name || sample.code || sample.order_number || targetId;
      if (operation === 'insert') return `Created new ${table}: ${idField}`;
      if (operation === 'update') return `Updated ${table}: ${idField}`;
      if (operation === 'delete') return `Deleted ${table}: ${idField}`;
    }
  }
  return `ERP ${operation} on ${schema}.${table}`;
}

function buildAlertTitle({ schema, table, operation }) {
  const actionType = classifyActionType(schema, table) || operation.toUpperCase();
  switch (actionType) {
    case 'STOCK_UPDATE':        return `📦 Stock ${operation === 'delete' ? 'Removed' : 'Updated'}`;
    case 'ORDER_CREATE':        return `🛒 Order ${operation === 'delete' ? 'Cancelled' : 'Created'}`;
    case 'JOURNAL_CREATE':      return `📒 Journal Entry Posted`;
    case 'ACCOUNT_UPDATE':      return `🏦 Account Updated`;
    case 'STAFF_UPDATE':        return `👤 Staff Record Updated`;
    case 'PRODUCTION_CREATE':   return `🏭 Production Job Started`;
    case 'PAYMENT_RECORD':      return `💳 Payment Recorded`;
    case 'BOOKING_CREATE':      return `📅 Booking Created`;
    case 'SHIPMENT_CREATE':    return `🚚 Shipment Created`;
    case 'PO_CREATE':           return `📋 Purchase Order Created`;
    case 'STOCK_ADJUST':        return `🔧 Stock Adjustment`;
    case 'STOCK_MOVE':          return `↔️ Stock Movement`;
    default:                    return `${operation.toUpperCase()} ${table}`;
  }
}

function buildAlertMessage({ schema, table, operation, data, targetId }) {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0] || {};
  const id = row.name || row.id || row.order_number || row.code || targetId;
  return `${schema}.${table} · ${operation} · ${id || ''}`.trim();
}

function buildAlertType(schema, table, operation) {
  const actionType = classifyActionType(schema, table);
  if (actionType) return actionType;
  if (operation === 'delete') return 'DELETE_OPERATION';
  if (operation === 'insert') return 'CREATE_OPERATION';
  return 'UPDATE_OPERATION';
}

// ─── Operation logger ────────────────────────────────────────────────────────
async function writeOperationLog({ schema, table, operation, data, filters, resultData, user_email, user_role }) {
  if (!sqlProxyConfigured) return;
  // Never log writes to the log/alert tables themselves
  if (schema === 'public' && ['audit_logs', 'alerts'].includes(table)) return;

  const auditAction = classifyActionType(schema, table) || operation.toUpperCase();
  const description = buildAuditDescription({ schema, table, operation, data, resultData });
  const targetId = Array.isArray(data) ? (data[0]?.id || data[0]?.name || null) : (data?.id || data?.name || null);

  try {
    await insertSqlRows({
      schema: 'public',
      table: 'audit_logs',
      data: {
        user_email:    user_email  || 'system@espressgo.local',
        user_role:     user_role   || 'system',
        action:        auditAction,
        table_affected: `${schema}.${table}`,
        record_id:     targetId,
        description,
        new_value: { data: data || null, filters: filters || null },
      },
      returning: '*',
    });
  } catch {
    // Audit logging must not block the ERP workflow.
  }

  try {
    await insertSqlRows({
      schema: 'public',
      table: 'alerts',
      data: {
        title:      buildAlertTitle({ schema, table, operation }),
        message:    buildAlertMessage({ schema, table, operation, data, targetId }),
        alert_type: buildAlertType(schema, table, operation),
        is_read:    false,
      },
      returning: '*',
    });
  } catch {
    // Alerts are secondary to the requested operation.
  }
}

function mergeReturnedRowsWithPayload(data, resultData) {
  const payloadRows = normalizeRows(data);
  const returnedRows = normalizeRows(resultData);
  const rowCount = Math.max(payloadRows.length, returnedRows.length);
  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    rows.push({
      ...(payloadRows[index] && typeof payloadRows[index] === 'object' ? payloadRows[index] : {}),
      ...(returnedRows[index] && typeof returnedRows[index] === 'object' ? returnedRows[index] : {}),
    });
  }

  return rows.filter((row) => Object.keys(row).length > 0);
}

function sourceOrderNumber(table, row) {
  if (table === 'retail_purchases') {
    return row.purchase_number || row.purchase_ref || row.order_number || row.id;
  }
  return row.order_number || row.purchase_number || row.id;
}

function fulfillmentCodeFor(table, row) {
  const sourceNumber = sourceOrderNumber(table, row);
  return sourceNumber ? `FUL-${sourceNumber}` : null;
}

function fulfillmentPayloadForSourceOrder(table, row) {
  const sourceNumber = sourceOrderNumber(table, row);
  const fulfillmentCode = fulfillmentCodeFor(table, row);
  if (!sourceNumber || !fulfillmentCode) return null;

  const isRetail = table === 'retail_purchases';
  let itemsList = (row.items || [])
    .map(it => ({
      item_code: it.item_code || it.code || '',
      item_name: it.name || it.product_name || '',
      qty: it.qty || it.quantity || 1
    }));
  if (itemsList.length === 0 && row.notes) {
    try {
      itemsList = row.notes
        .split('|')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
          const match = part.match(/^(\d+)\s*[xX×]\s*(.+)$/);
          return match
            ? { item_code: match[2].trim(), item_name: match[2].trim(), qty: parseInt(match[1]) || 1 }
            : { item_code: part, item_name: part, qty: 1 };
        });
    } catch { /* ignore */ }
  }
  return {
    fulfillment_id: fulfillmentCode,
    order_id: sourceNumber,
    customer_name: row.customer_name || row.client_name || row.company_name || 'Customer',
    shipping_address: row.shipping_address || row.delivery_address || row.address || '',
    customer_phone: row.customer_phone || row.phone || null,
    carrier: row.carrier || (isRetail ? 'NinjaVan Retail Express' : 'NinjaVan Express B2B'),
    service_type: isRetail ? 'B2C Retail Delivery' : 'B2B Wholesale Delivery',
    tracking_number: row.tracking_number || 'Pending',
    total_amount: row.total_amount || 0,
    // `order_fulfillments.status` is a shipping/fulfillment state machine — its
    // CHECK constraint only accepts shipping statuses ('Pending', 'Processing',
    // 'Dispatched', 'Shipped', 'Delivered', 'Cancelled', etc.), not customer-
    // facing refund states. Map order-side refund state to a safe fulfillment
    // state ('Processing' keeps the row existing; 'Cancelled' is preserved
    // because it's known to be allowed by the constraint) and rely on
    // `fulfillment_orders.refund_pending` / `retail_purchases.status` to carry
    // the refund signal — those tables don't share the constraint.
    status: row.status === 'Cancelled' ? 'Cancelled'
          : row.status === 'Refund Requested' ? 'Processing'
          : 'Processing',
    priority: isRetail ? 'normal' : 'high',
    notes: row.notes || row.product || row.item || '',
    items_json: itemsList.length > 0 ? JSON.stringify(itemsList) : null,
    production_batch_codes: row.production_batch_code ? [row.production_batch_code] : null,
  };
}

async function upsertFulfillmentRows(rows) {
  const payloads = rows
    .map((row) => fulfillmentPayloadForSourceOrder(row.__sourceTable, row))
    .filter(Boolean);

  // Track which source tables we touched so rollback can identify them.

  for (const payload of payloads) {
    let fulfillmentRecord = null;
    const sourceRow = rows.find(r => fulfillmentPayloadForSourceOrder(r.__sourceTable, r)?.fulfillment_id === payload.fulfillment_id);
    const sourceTable = sourceRow?.__sourceTable;

    // Preserve any existing advanced fulfillment status. Without this guard,
    // every retail_purchases / orders update (e.g. flipping status to
    // 'Refund Requested' or 'Shipped') clobbers order_fulfillments.status back
    // to 'Processing', rolling already-shipped orders back. The source-of-
    // truth for refund state lives on retail_purchases.status and
    // fulfillment_orders.refund_pending, so we don't need to overwrite a
    // fulfillment status that's already further along.
    const FULFILLMENT_STATUS_RANK = new Map([
      ['Pending', 1],
      ['Processing', 2],
      ['Dispatched', 3],
      ['Shipped', 4],
      ['Delivered', 5],
      ['Completed', 5],
      ['Cancelled', 6],
      ['Refunded', 7],
      ['Closed', 8],
    ]);
    try {
      const existingRows = await selectRows({
        table: 'order_fulfillments',
        columns: 'status',
        filters: { where: [{ column: 'fulfillment_id', operator: 'eq', value: payload.fulfillment_id }] }
      });
      const existingStatus = existingRows && existingRows[0] && existingRows[0].status ? String(existingRows[0].status) : null;
      if (existingStatus) {
        const existingRank = FULFILLMENT_STATUS_RANK.get(existingStatus) || 0;
        const incomingRank = FULFILLMENT_STATUS_RANK.get(payload.status) || 0;
        if (existingRank >= incomingRank && existingRank > 0) {
          payload.status = existingStatus;
        }
      }
    } catch (_) { /* missing row is fine; proceed with payload as-is */ }

    try {
      if (sqlProxyConfigured) {
        const result = await upsertSqlRows({
          schema: 'public',
          table: 'order_fulfillments',
          data: payload,
          returning: '*',
          onConflict: 'fulfillment_id',
        });
        fulfillmentRecord = Array.isArray(result) ? result[0] : (result?.data?.[0] || null);
      } else if (supabaseAdmin) {
        const { data, error } = await supabaseAdmin
          .schema('public')
          .from('order_fulfillments')
          .upsert(payload, { onConflict: 'fulfillment_id', returning: 'representation' })
          .select()
          .single();
        if (error) throw new Error(error.message || error);
        fulfillmentRecord = data;
      }

      // FIFO allocation: split this order's qty across confirmed production batches
      if (sourceRow) {
        const items = payload.items_json
          ? (() => { try { return JSON.parse(payload.items_json); } catch { return []; } })()
          : [];
        if (items.length > 0) {
          // Ensure we have the fulfillment_record UUID — re-fetch if the upsert result didn't include it
          let fulfillmentRecordId = fulfillmentRecord?.id || null;
          if (!fulfillmentRecordId) {
            try {
              const fetched = await selectSql({
                schema: 'public',
                table: 'order_fulfillments',
                columns: 'id',
                filters: { where: [{ column: 'fulfillment_id', operator: 'eq', value: payload.fulfillment_id }] }
              });
              fulfillmentRecordId = fetched && fetched[0] && fetched[0].id ? fetched[0].id : null;
            } catch (lookupErr) {
              console.warn('[FIFO FG] Could not fetch fulfillment UUID:', lookupErr.message);
            }
          }

          const allocs = await allocateFGFIFO(
            payload.fulfillment_id,
            sourceTable || 'orders',
            payload.order_id,
            sourceRow,
            items
          );
          await insertFGAllocations(allocs, payload.fulfillment_id, fulfillmentRecordId);
        }
      }
    } catch (e) {
      // Roll back: delete the just-inserted order_fulfillments row and the source
      // order/retail_purchase row so the customer doesn't see a phantom order.
      // ALSO delete the production_fg_allocation row(s) we just wrote — otherwise
      // a failed checkout permanently reserves stock against the batch while the
      // source order is gone, blocking every future checkout of that product.
      // This is the exact Sugar symptom: a stuck allocation with no matching
      // source row ate 25 units out of batch capacity.
      console.error(`[FIFO FG] Allocation failed for ${payload.fulfillment_id} — rolling back source row. Reason: ${e.message}`);
      try {
        const sourceNumber = sourceOrderNumber(sourceTable || 'orders', sourceRow || {});
        if (sqlProxyConfigured) {
          await deleteSql({
            schema: 'public',
            table: 'order_fulfillments',
            filters: { eq: { fulfillment_id: payload.fulfillment_id } },
          }).catch(() => []);
          // Free allocations tied to this fulfillment OR this source order.
          // We delete by both because (a) earlier writes used the source order's
          // number, and (b) the rollback may have already wiped the source row
          // — fulfillment_id is still a reliable key for the in-flight insert.
          await deleteSql({
            schema: 'public',
            table: 'production_fg_allocation',
            filters: { eq: { fulfillment_id: payload.fulfillment_id } },
          }).catch((delErr) => console.warn('[FIFO FG] Rollback alloc delete (by fulfillment_id) skipped:', delErr?.message || delErr));
          if (sourceNumber) {
            await deleteSql({
              schema: 'public',
              table: 'production_fg_allocation',
              filters: { eq: { source_order_number: sourceNumber } },
            }).catch((delErr) => console.warn('[FIFO FG] Rollback alloc delete (by source) skipped:', delErr?.message || delErr));
          }
          if (sourceTable && sourceRow) {
            const pkCol = (await getPrimaryKeyColumns('public', sourceTable))[0] || 'id';
            const idVal = sourceRow[pkCol] ?? sourceRow.id ?? sourceRow.purchase_number ?? sourceRow.order_number;
            if (idVal != null) {
              await deleteSql({
                schema: 'public',
                table: sourceTable,
                filters: { eq: { [pkCol]: idVal } },
              }).catch(() => []);
            }
          }
        } else if (supabaseAdmin) {
          await supabaseAdmin
            .schema('public')
            .from('order_fulfillments')
            .delete()
            .eq('fulfillment_id', payload.fulfillment_id);
          // Free allocations tied to this fulfillment so the failed checkout
          // doesn't leave stale reservations against the batch.
          await supabaseAdmin
            .schema('public')
            .from('production_fg_allocation')
            .delete()
            .eq('fulfillment_id', payload.fulfillment_id);
          if (sourceNumber) {
            await supabaseAdmin
              .schema('public')
              .from('production_fg_allocation')
              .delete()
              .eq('source_order_number', sourceNumber);
          }
          if (sourceTable && sourceRow) {
            const pkCol = (await getPrimaryKeyColumns('public', sourceTable))[0] || 'id';
            const idVal = sourceRow[pkCol] ?? sourceRow.id ?? sourceRow.purchase_number ?? sourceRow.order_number;
            if (idVal != null) {
              await supabaseAdmin
                .schema('public')
                .from(sourceTable)
                .delete()
                .eq(pkCol, idVal);
            }
          }
        }
      } catch (rollbackErr) {
        console.error('[FIFO FG] Rollback failed:', rollbackErr.message);
      }
      // Re-throw so the HTTP caller can return 409 with structured detail.
      throw e;
    }

    // Fix 1 — release FG allocations when a source order transitions to a
    // terminal "we won't ship this" state. Previously these stale rows
    // reserved batch stock indefinitely, blocking future checkouts of the
    // same product. We only run after the FIFO block above succeeded, so
    // a failed checkout (which threw) never reaches this point.
    try {
      const releaseStatuses = new Set([
        'cancelled', 'canceled',
        'refund_requested', 'refunded', 'refund rejected',
        'rejected', 'closed'
      ]);
      const sourceStatus = String(sourceRow?.status || '').trim().toLowerCase();
      if (sourceRow && releaseStatuses.has(sourceStatus)) {
        const sourceNumber = sourceOrderNumber(sourceTable, sourceRow);
        if (sourceNumber) {
          if (sqlProxyConfigured) {
            await deleteSql({
              schema: 'public',
              table: 'production_fg_allocation',
              filters: { eq: { source_order_number: sourceNumber } },
            }).catch((delErr) => console.warn('[FIFO FG] Release alloc skipped:', delErr?.message || delErr));
          } else if (supabaseAdmin) {
            await supabaseAdmin
              .schema('public')
              .from('production_fg_allocation')
              .delete()
              .eq('source_order_number', sourceNumber);
          }
          console.log(`[FIFO FG] Released FG allocations for ${sourceTable}:${sourceNumber} (status=${sourceStatus})`);
        }
      }
    } catch (releaseErr) {
      // Release is best-effort; never break the order write because of it.
      console.warn('[FIFO FG] Allocation release check failed:', releaseErr?.message || releaseErr);
    }
  }
}

async function deleteFulfillmentRowsForSourceOrders(table, rows) {
  for (const row of rows) {
    const fulfillmentCode = fulfillmentCodeFor(table, row);
    if (!fulfillmentCode) continue;

    if (sqlProxyConfigured) {
      await deleteSql({
        schema: 'public',
        table: 'order_fulfillments',
        filters: { eq: { fulfillment_id: fulfillmentCode } },
      }).catch(() => []);
    } else if (supabaseAdmin) {
      await supabaseAdmin
        .schema('public')
        .from('order_fulfillments')
        .delete()
        .eq('fulfillment_id', fulfillmentCode);
    }
  }
}

async function syncFulfillmentForCustomerOrderMutation({ target, operation, data, resultData }) {
  if (target?.schema !== 'public') return;
  if (!['retail_purchases', 'orders', 'customer_orders'].includes(target.table)) return;

  if (['insert', 'upsert', 'update'].includes(operation)) {
    const rows = mergeReturnedRowsWithPayload(data, resultData)
      .map((row) => ({ ...row, __sourceTable: target.table }))
      .filter((row) => sourceOrderNumber(target.table, row));
    await upsertFulfillmentRows(rows);
    return;
  }

  if (operation === 'delete') {
    await deleteFulfillmentRowsForSourceOrders(target.table, normalizeRows(resultData));
  }
}

// ─── FIFO Finished Goods Allocation ───────────────────────────────────────────────

/**
 * allocateFGFIFO(fulfillmentId, sourceTable, items)
 *
 * For each item in the order, allocates qty from confirmed production batches
 * in FIFO order (oldest confirmed_at first). Records splits in production_fg_allocation.
 *
 * @param {string} fulfillmentId  - The fulfillment_id from order_fulfillments
 * @param {string} sourceTable     - 'orders' | 'customer_orders' | 'retail_purchases'
 * @param {string} sourceOrderId  - The order number / purchase number
 * @param {object} orderRow       - Full order row for customer details
 * @param {Array}  items          - [{item_code, item_name, qty}] from the order
 * @returns {Array} allocation records created
 */
async function allocateFGFIFO(fulfillmentId, sourceTable, sourceOrderId, orderRow, items) {
  const allocations = [];

  for (const item of items) {
    const productName = item.item_name || item.name || '';
    const productCode = item.item_code || item.code || '';
    const qtyNeeded  = parseFloat(item.qty || item.quantity || 0);

    if (!qtyNeeded || qtyNeeded <= 0) continue;

    // Find confirmed production batches for this product, ordered by confirmed_at (FIFO)
    const batches = await selectRows({
      table: 'production_batches',
      filters: {
        where: [
          { column: 'status', operator: 'eq', value: 'confirmed' },
          { column: 'product_name', operator: 'eq', value: productName }
        ],
        order: { column: 'confirmed_at', ascending: true }
      }
    });

    // Fallback: match by product_code if name match is empty
    let confirmedBatches = batches.filter(b => b.confirmed_at);
    if (confirmedBatches.length === 0) {
      confirmedBatches = await selectRows({
        table: 'production_batches',
        filters: {
          where: [
            { column: 'status', operator: 'eq', value: 'confirmed' },
            { column: 'product_code', operator: 'eq', value: productCode }
          ],
          order: { column: 'confirmed_at', ascending: true }
        }
      });
    }

    // Also include batches from consumed_rm_batches JSONB (for legacy batches without confirmed_at)
    if (confirmedBatches.length === 0) {
      confirmedBatches = await selectRows({
        table: 'production_batches',
        filters: {
          where: [
            { column: 'status', operator: 'eq', value: 'confirmed' },
            { column: 'qty_produced', operator: 'gt', value: 0 }
          ],
          order: { column: 'created_at', ascending: true }
        }
      });
    }

    // Deduct already-allocated qty from each batch's available amount
    // by summing qty_allocated from production_fg_allocation
    const allocMap = {};
    // Terminal statuses on the source order mean "we already gave this stock
    // to the customer" — the batch is free to be sold again. We treat these
    // as fully fulfilled even when production_fg_allocation.qty_fulfilled
    // was never bumped (the dispatch path doesn't currently write it).
    const FULFILLED_SOURCE_STATUSES = new Set([
      'fulfilled', 'shipped', 'delivered', 'completed', 'complete',
      'refunded', 'refund_requested', 'cancelled', 'canceled',
      'rejected', 'closed'
    ]);
    for (const batch of confirmedBatches) {
      const batchCode = batch.batch_code;
      if (!allocMap[batchCode]) {
        const existing = await selectRows({
          table: 'production_fg_allocation',
          filters: {
            where: [{ column: 'production_batch_code', operator: 'eq', value: batchCode }]
          }
        });

        // Fix 2 — released or shipped allocations no longer reserve batch
        // stock. We treat an allocation's qty as "still reserved" unless
        // either qty_fulfilled has caught up to qty_allocated, OR the
        // source order has reached a terminal status (shipped, delivered,
        // refunded, cancelled, …). Without this, a single one-time sale
        // permanently locked that batch from future checkouts — the
        // original Sugar symptom.
        //
        // Debug summary is collected so we can emit one log line per
        // product explaining exactly what the gate saw for each batch.
        const debug = { perAllocation: [], perBatch: {} };
        const computeReserved = async () => {
          if (!existing || existing.length === 0) return 0;

          // Stage 1: every allocation row counts at least (qty_allocated −
          // qty_fulfilled) toward reserved stock. We treat this as the
          // lower bound for shipped / fulfilled orders.
          let reserved = 0;
          const candidates = [];
          for (const r of existing) {
            const allocated = parseFloat(r.qty_allocated || 0);
            const fulfilled = parseFloat(r.qty_fulfilled || 0);
            if (!Number.isFinite(allocated) || allocated <= 0) continue;
            const fulfilledSafe = Number.isFinite(fulfilled) ? fulfilled : 0;
            const stage1 = Math.max(0, allocated - fulfilledSafe);
            reserved += stage1;
            candidates.push({ row: r, allocated, stage1 });
          }

          // Stage 2: for allocations whose source_order_number resolves to
          // a terminal-status source row, that source's FULL qty counts
          // as released (i.e. subtract the unreleased portion too). This
          // is the path that actually frees Sugar today, since the
          // dispatch flow writes to inventory_logs but never bumps
          // production_fg_allocation.qty_fulfilled.
          //
          // We probe each candidate table using the same column-name
          // heuristics as sourceOrderNumber() (purchase_number →
          // purchase_ref → order_number) so we work on every table that
          // writes into production_fg_allocation.source_order_number,
          // including retail_purchases (purchase_number) and any future
          // table where the column may differ.
          //
          // Orphan reservation safety net: if NO source row matches the
          // recorded source_order_number in any candidate table, we
          // treat that allocation as released. This protects against
          // historical / rolled-back / manually-deleted source rows
          // that would otherwise permanently reserve batch stock — the
          // exact Sugar scenario from the original bug.
          const SOURCE_NUMBER_COLUMNS = ['order_number', 'purchase_number', 'purchase_ref', 'id'];
          const SOURCE_TABLES = ['retail_purchases', 'orders', 'customer_orders'];
          const sourceStatusCache = new Map();
          for (const c of candidates) {
            const orderNumber = c.row.source_order_number;
            if (!orderNumber) {
              debug.perAllocation.push({
                source: c.row.source_order_number || '(none)',
                qty: c.allocated, stage1: c.stage1,
                action: 'no-source-number → counted as reserved',
              });
              continue;
            }
            if (!sourceStatusCache.has(orderNumber)) {
              let status = null;
              let sourceFound = false;
              let sourceTbl = null;
              let sourceCol = null;
              outer: for (const tbl of SOURCE_TABLES) {
                for (const col of SOURCE_NUMBER_COLUMNS) {
                  try {
                    const rows = await selectRows({
                      table: tbl,
                      columns: 'status',
                      filters: { where: [{ column: col, operator: 'eq', value: orderNumber }] }
                    });
                    if (rows && rows.length > 0 && rows[0].status) {
                      status = String(rows[0].status).toLowerCase();
                      sourceFound = true;
                      sourceTbl = tbl;
                      sourceCol = col;
                      break outer;
                    }
                  } catch (_) { /* tolerate missing columns and try next */ }
                }
              }
              sourceStatusCache.set(orderNumber, { status, sourceFound, sourceTbl, sourceCol });
            }
            const cached = sourceStatusCache.get(orderNumber);
            const isTerminalStatus = cached.status && FULFILLED_SOURCE_STATUSES.has(cached.status);
            const isOrphan = !cached.sourceFound;
            let action;
            if (isTerminalStatus) {
              reserved -= c.allocated;
              action = `TERMINAL status="${cached.status}" → released`;
            } else if (isOrphan) {
              reserved -= c.allocated;
              action = 'ORPHAN (no source row found) → released';
            } else {
              action = `source status="${cached.status || 'null'}" → still reserved`;
            }
            debug.perAllocation.push({
              source: orderNumber,
              qty: c.allocated,
              stage1: c.stage1,
              resolved: cached.sourceTbl ? `${cached.sourceTbl}.${cached.sourceCol}` : '(no match)',
              source_status: cached.status,
              action,
            });
          }
          return Math.max(0, reserved);
        };
        const totalAllocated = await computeReserved();
        debug.perBatch[batchCode] = {
          qty_produced: parseFloat(batch.qty_produced || 0),
          totalAllocated,
          available: parseFloat(batch.qty_produced || 0) - totalAllocated,
        };

        allocMap[batchCode] = {
          batch,
          available: parseFloat(batch.qty_produced || 0) - totalAllocated
        };
        // Per-batch diagnostic: shows exactly what the gate saw for each
        // allocation row pointing at this batch. Helps diagnose Sugar-style
        // "0 available despite real stock" reports without re-querying DB.
        try {
          console.log(`[FIFO FG][batch ${batchCode}] product=${productName} qty_produced=${batch.qty_produced} totalAllocated=${totalAllocated} available=${allocMap[batchCode].available}`);
          for (const d of debug.perAllocation) {
            console.log(`[FIFO FG][batch ${batchCode}]   alloc: ${JSON.stringify(d)}`);
          }
        } catch (_) { /* never break the gate on log failure */ }
      }
    }

    let remaining = qtyNeeded;
    let fifoOrder = 1;

    for (const [batchCode, info] of Object.entries(allocMap)) {
      if (remaining <= 0) break;
      if (info.available <= 0) continue;

      const qtyAllocated = Math.min(remaining, info.available);
      if (qtyAllocated <= 0) continue;

      const unitPrice   = parseFloat(item.unit_price || item.price || 0);
      const lineTotal   = qtyAllocated * unitPrice;
      const segment     = (sourceTable === 'retail_purchases') ? 'b2c' : 'b2b';

      const record = {
        fulfillment_record_id: fulfillmentId, // we'll set this after inserting fulfillment
        fulfillment_id:        fulfillmentId,
        source_table:          sourceTable,
        source_order_id:      orderRow.id || null,
        source_order_number:   sourceOrderId,
        customer_name:        orderRow.customer_name || orderRow.client_name || null,
        customer_email:       orderRow.customer_email || null,
        customer_phone:       orderRow.customer_phone || orderRow.phone || null,
        shipping_address:      orderRow.shipping_address || orderRow.delivery_address || null,
        segment,
        payment_status:       orderRow.payment_status || null,
        production_batch_id:   info.batch.id || null,
        production_batch_code: batchCode,
        fg_lot_number:        info.batch.fg_lot_number || batchCode,
        product_name:         productName,
        product_code:         productCode,
        qty_allocated:        qtyAllocated,
        qty_fulfilled:        0,
        unit_price:           unitPrice,
        line_total:           Math.round(lineTotal * 100) / 100,
        fifo_order:           fifoOrder,
        allocated_at:         new Date().toISOString(),
        fulfilled_at:         null,
        carrier:              orderRow.carrier || null,
        tracking_number:      orderRow.tracking_number || 'Pending',
        shipped_at:          null,
        delivery_date:        null,
        shipping_status:      'Pending'
      };

      allocations.push(record);
      remaining -= qtyAllocated;
      fifoOrder++;
    }

    if (remaining > 0.001) {
      // Hard-block: insufficient confirmed-batch stock for this order line.
      // Throw a structured error so the caller can roll back the just-inserted
      // source row and surface a 409 to the client.
      const err = new Error(
        `[FIFO FG] Insufficient stock for ${productName}: needed ${qtyNeeded}, available ${qtyNeeded - remaining} (${remaining} short)`
      );
      err.code = 'INSUFFICIENT_FG_STOCK';
      err.product_name = productName;
      err.product_code = productCode;
      err.requested = qtyNeeded;
      err.allocated = qtyNeeded - remaining;
      err.short = remaining;
      err.fulfillment_id = fulfillmentId;
      throw err;
    }
  }

  return allocations;
}

/**
 * Insert FG allocation records into production_fg_allocation,
 * then update the fulfillment record with the first batch code.
 */
async function insertFGAllocations(allocations, fulfillmentId, fulfillmentRecordId) {
  if (!allocations || allocations.length === 0) return;

  for (const alloc of allocations) {
    alloc.fulfillment_record_id = fulfillmentRecordId || alloc.fulfillment_record_id;
    await upsertSqlRows({
      schema: 'public',
      table: 'production_fg_allocation',
      data: alloc,
      returning: 'id'
    });
  }

  // Update fulfillment_records with production_batch_codes array
  const batchCodes = [...new Set(allocations.map(a => a.production_batch_code))];
  await upsertSqlRows({
    schema: 'public',
    table: 'order_fulfillments',
    data: {
      fulfillment_id: fulfillmentId,
      production_batch_codes: batchCodes
    },
    onConflict: 'fulfillment_id'
  });

  // NOTE: FG inventory deduction disabled — stock is no longer deducted at checkout.
  // Allocations are still recorded for traceability, but inventory.current_stock is left untouched.
}

/**
 * Sweep production_fg_allocation rows that no longer reference a live
 * source order. These are orphans — typically left behind by a previous
 * failed checkout where the gate rejected AFTER the source row was
 * deleted in cleanup. Without this sweep, those orphans permanently
 * reserve batch stock against no real order. Fix 2 treats orphans as
 * released during the FIFO pass, so orphans are non-fatal, but a one-
 * shot sweep on boot keeps the table tidy and the live accounting
 * honest. Safe to run repeatedly; idempotent.
 */
async function sweepOrphanFGAllocations() {
  const SOURCE_NUMBER_COLUMNS = ['order_number', 'purchase_number', 'purchase_ref', 'id'];
  const SOURCE_TABLES = ['retail_purchases', 'orders', 'customer_orders'];

  const allAllocs = await selectRows({
    table: 'production_fg_allocation',
    filters: {},
  });
  if (!Array.isArray(allAllocs) || allAllocs.length === 0) {
    console.log('[FIFO FG] Orphan sweep: nothing to scan.');
    return 0;
  }

  const bySource = new Map();
  for (const a of allAllocs) {
    const k = a.source_order_number;
    if (!k) continue;
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(a);
  }

  let released = 0;
  for (const [orderNumber, rows] of bySource) {
    let sourceFound = false;
    outer: for (const tbl of SOURCE_TABLES) {
      for (const col of SOURCE_NUMBER_COLUMNS) {
        try {
          const found = await selectRows({
            table: tbl,
            columns: 'id',
            filters: { where: [{ column: col, operator: 'eq', value: orderNumber }] }
          });
          if (Array.isArray(found) && found.length > 0) {
            sourceFound = true;
            break outer;
          }
        } catch (_) { /* try next column */ }
      }
    }
    if (sourceFound) continue;

    for (const a of rows) {
      try {
        if (sqlProxyConfigured) {
          await deleteSql({
            schema: 'public',
            table: 'production_fg_allocation',
            filters: { eq: { id: a.id } },
          }).catch(() => {});
        } else if (supabaseAdmin) {
          await supabaseAdmin
            .schema('public')
            .from('production_fg_allocation')
            .delete()
            .eq('id', a.id);
        }
        released++;
      } catch (delErr) {
        console.warn(`[FIFO FG] Orphan sweep could not delete allocation id=${a?.id}:`, delErr?.message || delErr);
      }
    }
    console.log(`[FIFO FG] Orphan sweep: released ${rows.length} allocation(s) for missing source ${orderNumber}`);
  }

  console.log(`[FIFO FG] Orphan sweep complete: ${released} allocation row(s) released across ${bySource.size} source order(s) scanned.`);
  return released;
}

/**
 * Backfill production_fg_allocation from existing fulfillment_records
 * and production_batches for any historical orders without allocations.
 */
async function backfillFGAllocations() {
  // Get all fulfillment records without allocations
  const unallocated = await selectRows({
    table: 'order_fulfillments',
    filters: {
      where: [
        { column: 'status', operator: 'nin', value: ['Pending', 'Cancelled'] }
      ]
    }
  });

  let created = 0;
  for (const fulf of unallocated || []) {
    const existing = await selectRows({
      table: 'production_fg_allocation',
      filters: {
        where: [{ column: 'fulfillment_id', operator: 'eq', value: fulf.fulfillment_id }]
      }
    });
    if (existing && existing.length > 0) continue; // already has allocation

    let items = [];
    try { items = JSON.parse(fulf.items_json || '[]'); } catch { /* ignore */ }

    if (!items || items.length === 0) continue;

    // Determine source table from order_id pattern
    const sourceTable = fulf.order_id?.startsWith('PO-') || fulf.order_id?.startsWith('PUR')
      ? 'retail_purchases'
      : 'orders';

    const orderRow = {
      id:              fulf.order_id,
      customer_name:    fulf.customer_name,
      customer_email:   null,
      customer_phone:   fulf.customer_phone,
      shipping_address: fulf.shipping_address,
      carrier:         fulf.carrier,
      tracking_number:  fulf.tracking_number,
      payment_status:  null
    };

    const allocs = await allocateFGFIFO(
      fulf.fulfillment_id,
      sourceTable,
      fulf.order_id,
      orderRow,
      items
    );

    await insertFGAllocations(allocs, fulf.fulfillment_id, fulf.id);
    created += allocs.length;
  }

  console.log(`[FIFO FG] Backfill complete: ${created} allocation records created`);
  return created;
}

/**
 * Thin wrapper around the SQL proxy's select — works when sqlProxyConfigured
 */
async function selectRows({ table, filters = {} }) {
  if (sqlProxyConfigured) {
    try {
      const result = await executeSqlOperation({
        operation: 'select',
        table,
        schema: 'public',
        columns: '*',
        ...filters
      });
      // executeSqlOperation returns the rows array directly for selects.
      // Guard against the legacy { data, error } wrapper shape for safety.
      if (Array.isArray(result)) return result;
      return (result && Array.isArray(result.data)) ? result.data : (result || []);
    } catch (e) {
      console.warn(`[selectRows] ${table}:`, e.message);
      return [];
    }
  }
  if (supabaseAdmin) {
    let q = supabaseAdmin.from(table).select('*');
    if (filters.where) {
      for (const cond of filters.where) {
        q = q.eq(cond.column, cond.value);
      }
    }
    if (filters.order) {
      q = q.order(filters.order.column, { ascending: filters.order.ascending });
    }
    const { data, error } = await q;
    if (error) { console.warn(`[selectRows] ${table}:`, error); return []; }
    return data || [];
  }
  return [];
}

function queueFulfillmentSync(payload) {
  syncFulfillmentForCustomerOrderMutation(payload).catch((error) => {
    console.warn('Fulfillment sync skipped:', error?.message || error);
  });
}

// Awaits the fulfillment sync so HTTP callers can return a structured 409
// when FIFO allocation fails. Use ONLY for order-creation paths that must
// fail-fast on insufficient FG stock.
async function awaitFulfillmentSync(payload) {
  try {
    await syncFulfillmentForCustomerOrderMutation(payload);
  } catch (error) {
    if (error && error.code === 'INSUFFICIENT_FG_STOCK') {
      const err = new Error(`Insufficient stock for ${error.product_name}: ${error.short} unit(s) short.`);
      err.code = 'INSUFFICIENT_FG_STOCK';
      err.httpStatus = 409;
      err.product_name = error.product_name;
      err.product_code = error.product_code;
      err.requested = error.requested;
      err.allocated = error.allocated;
      err.short = error.short;
      err.fulfillment_id = error.fulfillment_id;
      throw err;
    }
    throw error;
  }
}

// ─── Server-side RBAC enforcement ───────────────────────────────────────────────

// Maps table → permission required per operation type.
const TABLE_WRITE_PERMISSIONS = {
    'profiles':             'staff:write',
    'employees':             'staff:write',
    'staff_salaries':       'salary:write',
    'payroll':               'salary:write',
    'inventory':             'inventory:write',
    'inventory_batches':     'inventory:write',
    'ingredients':           'raw_materials:write',
    'purchase_orders':       'raw_materials:write',
    'purchase_records':      'raw_materials:write',
    'raw_material_orders':   'raw_materials:write',
    'suppliers':             'supplier:write',
    'supplier_quotations':   'supplier:write',
    'production_jobs':       'production:write',
    'production_batches':    'production:write',
    'production_recipes':    'recipes:write',
    'finished_goods':        'inventory:write',
    'journal_entries':       'journal:write',
    'journal_accounts':      'finance:write',
    'entries':               'journal:write',
    'entry_lines':           'journal:write',
    'accounts':             'finance:write',
    'orders':               'orders:write',    // legacy alias
    'order_items':          'orders:write',
    'support_tickets':       'support:write',
    'support_messages':       'support:write',
    'chat_messages':         'support:write',
    'outreach_campaigns':     'outreach:write',
    'factory_bookings':      'factory:write',
    'overheads':             'finance:write',
    'warehouse_slot_items': 'warehouse_map:write',
    'alerts':               'alerts:write',
    'audit_logs':           'alerts:admin',
};

const SERVER_PERMISSIONS = {
    'staff:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'staff:write':   ['admin'],
    'salary:read':   ['admin', 'accountant'],
    'salary:write':  ['admin'],
    'inventory:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'inventory:write':   ['admin', 'procurement', 'production'],
    'raw_materials:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic'],
    'raw_materials:write':   ['admin', 'procurement'],
    'recipes:read':    ['admin', 'accountant', 'production'],
    'recipes:write':   ['admin', 'production'],
    'production:read':    ['admin', 'accountant', 'production', 'logistic'],
    'production:write':   ['admin', 'production'],
    'finance:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic'],
    'finance:write':   ['admin', 'accountant'],
    'journal:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'journal:write':   ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'orders:read':    ['admin', 'accountant', 'logistic', 'sales'],
    'orders:write':   ['admin', 'sales', 'client'],
    'support:read':    ['admin', 'logistic', 'sales'],
    'support:write':   ['admin', 'logistic', 'sales'],
    'supplier:read':    ['admin', 'accountant', 'procurement', 'logistic', 'sales'],
    'supplier:write':   ['admin', 'procurement'],
    'outreach:read':    ['admin', 'procurement', 'sales'],
    'outreach:write':   ['admin', 'sales'],
    'factory:read':    ['admin', 'procurement', 'production', 'logistic'],
    'factory:write':   ['admin', 'production', 'logistic'],
    'warehouse_map:read':    ['admin', 'procurement', 'production', 'logistic'],
    'warehouse_map:write':   ['admin', 'production', 'logistic'],
    'alerts:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'alerts:write':   ['admin'],
    'alerts:admin':   ['admin'],
    'settings:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'settings:write':   ['admin'],
};

/**
 * Returns true if the given user_role is allowed to perform the given permission.
 */
function serverCan(userRole, permission) {
    const allowed = SERVER_PERMISSIONS[permission];
    if (!allowed) return false; // unknown permission → deny by default
    return allowed.includes(userRole);
}

/**
 * Determines the required permission for a write operation on a given table.
 * Returns null if no special permission is needed.
 */
function requiredPermissionForTable(table) {
    return TABLE_WRITE_PERMISSIONS[table] || null;
}

function enforceServerRBAC(operation, table, userRole) {
    // Only enforce on write operations
    const writeOps = new Set(['insert', 'upsert', 'update', 'delete']);
    if (!writeOps.has(operation)) return null;

    const required = requiredPermissionForTable(table);
    if (!required) return null; // no special permission required for this table

    if (!effectiveServerCan(userRole, required)) {
        return `Forbidden: role "${userRole}" cannot perform "${operation}" on "${table}" (requires ${required})`;
    }
    return null;
}

// ─── Dynamic RBAC overrides ─────────────────────────────────────────────────
//
// The rbac_overrides table holds per-(permission_key, role) flips on top of
// SERVER_PERMISSIONS. An absent row means "use the default". This cache is
// rebuilt lazily — first read after expiry triggers a single SELECT. Writes
// invalidate it instantly so admins see their changes propagate immediately.
//
// Cache TTL is intentionally short (30s) so a crashed invalidate or a stale
// process self-heals within half a minute. effectiveServerCan below always
// falls back to the hardcoded SERVER_PERMISSIONS map if the cache hasn't
// loaded yet — so an empty database never locks anyone out.

const RBAC_CACHE_TTL_MS = 30_000;
let effectiveRbacCache = null;      // { permissions: Map<permKey, Set<role>>, loadedAt: number, defaultsHash: string }
let effectiveRbacLoadPromise = null;

function defaultsHash() {
    // Cheap fingerprint of SERVER_PERMISSIONS so a code deploy invalidates
    // the cache without manual flush. JSON.stringify order is stable because
    // the keys are inserted in lexical-ish order in the source above.
    return JSON.stringify(SERVER_PERMISSIONS);
}

async function loadEffectiveRbacFromDb() {
    if (!sqlProxyConfigured || sqlProxyDisabled) {
        // No DB → effective = defaults. Cache as such.
        return {
            permissions: new Map(), // no overrides
            loadedAt: Date.now(),
            defaultsHash: defaultsHash(),
            source: 'defaults-only-no-sql-proxy',
        };
    }
    let overrides = [];
    try {
        const rows = await runManagementSql(
            'SELECT permission_key, role, value FROM public.rbac_overrides'
        );
        overrides = Array.isArray(rows) ? rows : [];
    } catch (err) {
        // DB error: log once, fall back to defaults so the app stays usable.
        console.warn('[rbac] failed to read rbac_overrides, using defaults:', err.message || err);
        overrides = [];
    }
    return {
        permissions: new Map(overrides.map((r) => [r.permission_key + '|' + r.role, !!r.value])),
        loadedAt: Date.now(),
        defaultsHash: defaultsHash(),
        source: 'db',
        rowCount: overrides.length,
    };
}

async function getEffectiveRbac() {
    const hash = defaultsHash();
    if (
        effectiveRbacCache &&
        effectiveRbacCache.defaultsHash === hash &&
        Date.now() - effectiveRbacCache.loadedAt < RBAC_CACHE_TTL_MS
    ) {
        return effectiveRbacCache;
    }
    // Coalesce concurrent loads — if another request is already fetching,
    // just await its promise instead of firing a second SELECT.
    if (!effectiveRbacLoadPromise) {
        effectiveRbacLoadPromise = loadEffectiveRbacFromDb().finally(() => {
            effectiveRbacLoadPromise = null;
        });
    }
    const fresh = await effectiveRbacLoadPromise;
    effectiveRbacCache = fresh;
    return fresh;
}

function invalidateEffectiveRbacCache() {
    effectiveRbacCache = null;
    effectiveRbacLoadPromise = null;
}

/**
 * Effective permission check. Same signature as serverCan() so it can be
 * dropped into enforceServerRBAC. Admin role is hard-coded all-powerful and
 * never consults the DB (CHECK constraint on rbac_overrides already prevents
 * admin rows from being inserted).
 */
function effectiveServerCan(userRole, permission) {
    if (userRole === 'admin') return true;
    const allowed = SERVER_PERMISSIONS[permission];
    const defaultAllowed = allowed ? allowed.includes(userRole) : false;
    if (!effectiveRbacCache) return defaultAllowed; // cold cache → defaults
    const override = effectiveRbacCache.permissions.get(permission + '|' + userRole);
    if (override === undefined) return defaultAllowed; // no override row → default
    return override; // explicit true OR false override
}

const STAFF_ROLES = ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'];

function effectiveMatrix() {
    // Build the merged {permissionKey: [roles]} map that /api/rbac/effective
    // returns. Used both by the API endpoint and by the initial cache warm.
    const matrix = {};
    const keys = Object.keys(SERVER_PERMISSIONS);
    for (const key of keys) {
        const defaults = SERVER_PERMISSIONS[key] || [];
        const set = new Set(defaults);
        if (effectiveRbacCache) {
            for (const role of STAFF_ROLES) {
                const ov = effectiveRbacCache.permissions.get(key + '|' + role);
                if (ov === true) set.add(role);
                else if (ov === false) set.delete(role);
            }
        }
        // admin is always present
        set.add('admin');
        matrix[key] = Array.from(set);
    }
    return matrix;
}

async function snapshotRbacState() {
    // Captures the current rbac_overrides table as a JSON snapshot for
    // rbac_history.snapshot_before / snapshot_after. Returns null if the
    // table is empty.
    if (!sqlProxyConfigured || sqlProxyDisabled) return { rows: [] };
    try {
        const rows = await runManagementSql(
            'SELECT permission_key, role, value, updated_at, updated_by FROM public.rbac_overrides ORDER BY permission_key, role'
        );
        return { rows: Array.isArray(rows) ? rows : [] };
    } catch (err) {
        return { rows: [], error: err.message || String(err) };
    }
}

async function writeRbacOverrides(overrides) {
    // overrides: [{ permission_key, role, value, updated_by }]
    // The DB CHECK constraint rejects role='admin' rows server-side; the API
    // also rejects them defensively so the error is friendlier.
    const safe = (overrides || []).filter((r) => r && r.role !== 'admin' && r.permission_key);
    if (safe.length === 0) return;
    const esc = (s) => String(s ?? '').replace(/'/g, "''");
    const values = safe.map((r) => {
        return `('${esc(r.permission_key)}', '${esc(r.role)}', ${r.value ? 'true' : 'false'}, now(), '${esc(r.updated_by || '')}')`;
    }).join(',\n  ');
    const sql = `
        INSERT INTO public.rbac_overrides (permission_key, role, value, updated_at, updated_by)
        VALUES ${values}
        ON CONFLICT (permission_key, role) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by;
    `;
    await runManagementSql(sql);
}

async function deleteRbacOverrides(overrides) {
    const safe = (overrides || []).filter((r) => r && r.role !== 'admin' && r.permission_key);
    if (safe.length === 0) return;
    const esc = (s) => String(s ?? '').replace(/'/g, "''");
    const conds = safe.map((r) => `(permission_key='${esc(r.permission_key)}' AND role='${esc(r.role)}')`).join(' OR ');
    const sql = `DELETE FROM public.rbac_overrides WHERE ${conds};`;
    await runManagementSql(sql);
}

function requireStaffAdmin(req, res) {
    // Returns the session object if the caller is a logged-in staff admin,
    // otherwise writes a 401/403 response and returns null.
    const session = readStaffSessionFromRequest(req);
    if (!session) {
        sendJson(res, 401, { error: 'Not authenticated' });
        return null;
    }
    if (session.role !== 'admin') {
        sendJson(res, 403, { error: 'Admin role required' });
        return null;
    }
    return session;
}

// ─── Page-access enforcement ──────────────────────────────────────────────────
//
// Each staff page has a stable page_id (declared in rbac.js NAV_PERMISSIONS or
// EXTRA_STAFF_PAGES). The default for "can role X open page Y" is "yes if X
// has the page's permission in the effective matrix". rbac_page_access rows
// override that default on a per-(page_id, role) basis.
//
// This block:
//   1. Holds the page_id → path mapping (server-side copy of the client's).
//   2. Holds a 30s cache of the effective page-access set.
//   3. Resolves a URL path to a page_id and answers "can this role open it?".

const STAFF_PAGE_PATHS = {
    'supplier-management':   '/business-management/Supplier-management/index.html',
    'supplier-details':      '/business-management/Supplier-management/details.html',
    'supplier-onboard':      '/business-management/Supplier-management/onboard.html',
    'supplier-timeline':     '/business-management/Supplier-management/timeline.html',
    'customer-master':       '/business-management/customer-management/index.html',
    'customer-timeline':     '/business-management/customer-management/customer-timeline.html',
    'customer-verification': '/business-management/customer-management/big-business/customer-verification.html',
    'sales-dashboard':       '/business-management/customer-management/customer-order/index.html',
    'sales-dashboard-b2c':   '/business-management/customer-management/customer-order/b2c.html',
    'outreach':              '/business-management/outreach/email-outreach.html',
    'support-hub':           '/business-management/customer-management/support.html',
    'finance-dashboard':     '/business-management/finances/opertation.html',
    'traceability':          '/document/traceability.html',
    'purchase-record':       '/document/purchase-record.html',
    'fulfillment':           '/logistic/fulfillment.html',
    'warehouse-stock':       '/warehouse/inventory.html',
    'production':            '/production/index.html',
    'production-recipes':    '/warehouse/recipes.html',
    'factory-booking':       '/factory-booking/index.html',
    'staff-management':      '/staff-management/clock-in.html',
    'create-staff':          '/staff-management/create-staff.html',
    'staff-salaries':        '/staff-management/salaries.html',
    'rbac-admin':            '/settings/rbac.html',
    'alert-center':          '/settings/alert-center.html',
    // Protected files (account.html / account-detail.html) — never modify the
    // .html files themselves. Gate at the catalog + server-route level so they
    // open by default only for admin+accountant (finance:write holders).
    'finance-account':        '/business-management/finances/account.html',
    'finance-account-detail': '/business-management/finances/account-detail.html',
};

// Reverse lookup: path → page_id
const PAGE_ID_BY_PATH = Object.fromEntries(
    Object.entries(STAFF_PAGE_PATHS).map(([id, path]) => [path.toLowerCase(), id]),
);

// Mirror of client NAV_PERMISSIONS — which perm gates each page. The page is
// "default-open" for a role if the role has the page's perm.
const PAGE_PERMISSIONS = {
    'supplier-management':   'supplier:read',
    'customer-master':       'orders:read',
    'sales-dashboard':       'orders:read',
    'outreach':              'outreach:read',
    'support-hub':           'support:read',
    'finance-dashboard':     'finance:read',
    'traceability':          'production:read',
    'purchase-record':       'procurement:read',
    'fulfillment':           'orders:read',
    'warehouse-stock':       'inventory:read',
    'production':            'production:read',
    'production-recipes':    'recipes:read',
    'factory-booking':       'factory:read',
    'staff-management':      'staff:read',
    'create-staff':          'staff:write',
    'staff-salaries':        'salary:read',
    'rbac-admin':            'staff:write',   // admin-only
    'alert-center':          'alerts:write',  // admin-only by default
    // Protected finance pages — gate on finance:write so only admin+accountant
    // can open them by default. Greys out for every other role in the UI.
    'finance-account':        'finance:write',
    'finance-account-detail': 'finance:write',
};

let effectivePageAccessCache = null; // Map<pageId, Set<role>> (granted roles)
let effectivePageAccessLoadPromise = null;

async function loadEffectivePageAccessFromDb() {
    if (!sqlProxyConfigured || sqlProxyDisabled) return { map: new Map() };
    let overrides = [];
    try {
        const rows = await runManagementSql(
            'SELECT page_id, role, granted FROM public.rbac_page_access'
        );
        overrides = Array.isArray(rows) ? rows : [];
    } catch (err) {
        console.warn('[rbac] failed to read rbac_page_access, using defaults:', err.message || err);
        overrides = [];
    }
    return { map: new Map(overrides.map((r) => [r.page_id + '|' + r.role, !!r.granted])), rowCount: overrides.length };
}

async function getEffectivePageAccess() {
    if (effectivePageAccessCache) return effectivePageAccessCache;
    if (!effectivePageAccessLoadPromise) {
        effectivePageAccessLoadPromise = loadEffectivePageAccessFromDb().finally(() => {
            effectivePageAccessLoadPromise = null;
        });
    }
    effectivePageAccessCache = await effectivePageAccessLoadPromise;
    return effectivePageAccessCache;
}

function invalidateEffectivePageAccessCache() {
    effectivePageAccessCache = null;
    effectivePageAccessLoadPromise = null;
}

/**
 * Returns true if the given role is allowed to open the given page. Admin is
 * always allowed. The decision flow is:
 *   1. If rbac_page_access has an override row for (pageId, role), use it.
 *   2. Else if the page's perm is known and the role has it, allow.
 *   3. Else deny.
 */
async function effectiveCanOpenPage(pageId, userRole) {
    if (userRole === 'admin') return true;
    if (!pageId) return true; // not a known page → not gated
    const { map } = await getEffectivePageAccess();
    const override = map.get(pageId + '|' + userRole);
    if (override !== undefined) return override;
    // Fall back to the page's permission gate
    const required = PAGE_PERMISSIONS[pageId];
    if (!required) return true; // no gate configured
    return effectiveServerCan(userRole, required);
}

/**
 * Extract a page_id from a request path. Returns null if the path is not a
 * known staff page (public pages, assets, API routes → null = "not gated").
 */
function pageIdFromPath(requestPath) {
    if (!requestPath) return null;
    let p = requestPath.split('?')[0].toLowerCase();
    if (p.endsWith('/')) p += 'index.html';
    return PAGE_ID_BY_PATH[p] || null;
}

async function handleSupabaseApi(req, res) {
  let operation = 'select';

  try {
    const body = await readJsonBody(req);
    operation = body.operation || 'select';

    // ── Server-side RBAC check ────────────────────────────────────────────────
    // Trust hierarchy (most → least authoritative):
    //   1. espressgo_staff_session cookie (HS256-signed; verified above the
    //      trust boundary — the cookie alone proves the caller is a logged-in
    //      staff member with that role/department). Body claims cannot
    //      override it.
    //   2. Body user_role/body.user_email verified against public.staff_profiles.
    //      Used by tools / scripts that don't have a browser cookie.
    //   3. espressgo_session (customer) cookie — only 'client' grade.
    const staffCookie = readStaffSessionFromRequest(req);
    const cookieSession = readSessionFromRequest(req);
    if (staffCookie) {
      // The cookie has already proven the caller's role via loadStaffProfile()
      // at login time. Force the body's identity to match — body claims must
      // not be allowed to elevate, downgrade, or impersonate.
      body.user_role = staffCookie.role;
      body.user_email = staffCookie.email;
    } else {
      let bodyStaffVerified = false;
      if (body && body.user_role && body.user_email) {
        bodyStaffVerified = await verifyStaffRole(body.user_email, body.user_role);
      }
      if (cookieSession && !bodyStaffVerified) {
        body.user_role = 'client';
        body.user_email = cookieSession.email;
        // Optional: also lock the segment so a b2c cookie can't read b2b rows.
        if (cookieSession.segment && !body.segment) body.segment = cookieSession.segment;
      }
    }
    const userRole = body.user_role || 'unknown';
    const userEmail = body.user_email || null;
    const needsSql = sqlProxyConfigured && !sqlProxyDisabled;
    console.log(`[ERP Supabase API] operation=${operation} table=${body.table} userRole=${userRole} staffCookie=${staffCookie ? 'yes' : 'no'} cookie=${cookieSession ? 'yes' : 'no'} sqlProxy=${needsSql ? 'yes' : 'no'} bodyKeys=${Object.keys(body)}`);

    // Guard: require table for all non-DDL operations
    if (operation !== 'ddl' && operation !== 'raw' && operation !== 'cache_clear' && operation !== 'sql_update' && !body.table) {
      sendJson(res, 400, {
        data: null,
        error: 'table is required',
      });
      return;
    }

    if (userRole !== 'admin') {
      const rbacError = enforceServerRBAC(operation, body.table, userRole);
      if (rbacError) {
        sendJson(res, 403, {
          data: null,
          error: rbacError,
        });
        return;
      }
    }

    // Special guard for salaries table modifications
    if (body.table === 'salaries' && ['insert', 'update', 'upsert', 'delete'].includes(operation)) {
      let targetCycle = null;
      let existingStatus = null;

      if (['update', 'delete'].includes(operation)) {
        const validColumns = await ensureTableColumns('public', 'salaries', { noCache: false });
        const where = buildWhere(body.filters, validColumns);
        if (where) {
          const sql = `SELECT cycle, payment_status FROM public.salaries ${where} LIMIT 1`;
          const rows = parseSqlRows(await runManagementSql(sql));
          if (rows && rows.length > 0) {
            targetCycle = rows[0].cycle;
            existingStatus = rows[0].payment_status;
          }
        }
      } else if (['insert', 'upsert'].includes(operation)) {
        const rowData = Array.isArray(body.data) ? body.data[0] : body.data;
        targetCycle = rowData?.cycle;
        if (rowData?.id) {
          const sql = `SELECT cycle, payment_status FROM public.salaries WHERE id = ${sqlValue(rowData.id, 'id')} LIMIT 1`;
          const rows = parseSqlRows(await runManagementSql(sql));
          if (rows && rows.length > 0) {
            targetCycle = rows[0].cycle;
            existingStatus = rows[0].payment_status;
          }
        }
      }

    }

    let resultData;
    if (needsSql) {
      try {
        resultData = await executeSqlOperation(body);
      } catch (err) {
        if (['select', 'raw'].includes(operation) && isNonFatalReadError(err)) {
          resultData = [];
        } else {
          throw err;
        }
      }
    } else {
      resultData = await executeSupabaseJsFallback(body);
    }

    // Post-operation hook to sync payroll run and details if modifying salaries
    if (['update', 'upsert', 'insert', 'delete'].includes(operation) && body.table === 'salaries') {
      try {
        let cycleToUpdate = targetCycle;
        if (!cycleToUpdate) {
          let staffId = null;
          if (['update', 'delete'].includes(operation)) {
            const validColumns = await ensureTableColumns('public', 'salaries', { noCache: false });
            const where = buildWhere(body.filters, validColumns);
            if (where) {
              const sql = `SELECT cycle FROM public.salaries ${where} LIMIT 1`;
              const rows = parseSqlRows(await runManagementSql(sql));
              if (rows && rows.length > 0) cycleToUpdate = rows[0].cycle;
            }
          } else {
            const rowData = Array.isArray(body.data) ? body.data[0] : body.data;
            cycleToUpdate = rowData?.cycle;
          }
        }

        if (cycleToUpdate) {
          const runSql = `SELECT id FROM public.payroll_runs WHERE cycle = ${sqlValue(cycleToUpdate, 'cycle')} LIMIT 1`;
          const runRows = parseSqlRows(await runManagementSql(runSql));
          if (runRows && runRows.length > 0) {
            const runId = runRows[0].id;
            
            // Delete old details
            await runManagementSql(`DELETE FROM public.payroll_run_details WHERE payroll_run_id = ${sqlValue(runId, 'payroll_run_id')}`);
            
            // Fetch staff details
            const staffSql = `SELECT id, name, role FROM public.staff_profiles`;
            const staffRows = parseSqlRows(await runManagementSql(staffSql)) || [];
            const staffMap = new Map(staffRows.map(s => [s.id, s]));
            
            // Fetch salaries
            const salariesSql = `SELECT staff_id, salary_type, base_rate, hours_worked, bonus, deductions FROM public.salaries WHERE cycle = ${sqlValue(cycleToUpdate, 'cycle')}`;
            const currentSalaries = parseSqlRows(await runManagementSql(salariesSql)) || [];
            
            let totalPaid = 0;
            for (const sal of currentSalaries) {
              const profile = staffMap.get(sal.staff_id) || { name: 'Unknown', role: 'Staff' };
              const basePayCalculated = sal.salary_type === 'Monthly'
                ? parseFloat(sal.base_rate || 0)
                : (parseFloat(sal.base_rate || 0) * parseFloat(sal.hours_worked || 0));
              const grossPay = Math.max(0, basePayCalculated + parseFloat(sal.bonus || 0) - parseFloat(sal.deductions || 0));
              totalPaid += grossPay;
              
              await runManagementSql(`
                INSERT INTO public.payroll_run_details (
                  payroll_run_id, staff_id, staff_name, cycle, attempt_number,
                  salary_type, base_pay, hours_worked, bonus, deductions, gross_pay, net_pay
                ) VALUES (
                  ${sqlValue(runId, 'run_id')},
                  ${sqlValue(sal.staff_id, 'staff_id')},
                  ${sqlValue(profile.name, 'staff_name')},
                  ${sqlValue(cycleToUpdate, 'cycle')},
                  1,
                  ${sqlValue(sal.salary_type, 'salary_type')},
                  ${sqlValue(sal.base_rate, 'base_rate')},
                  ${sqlValue(sal.hours_worked, 'hours_worked')},
                  ${sqlValue(sal.bonus, 'bonus')},
                  ${sqlValue(sal.deductions, 'deductions')},
                  ${sqlValue(grossPay, 'gross_pay')},
                  ${sqlValue(grossPay, 'net_pay')}
                )
              `);
            }
            
            await runManagementSql(`
              UPDATE public.payroll_runs 
              SET total_paid = ${sqlValue(totalPaid, 'total_paid')}, 
                  staff_count = ${sqlValue(currentSalaries.length, 'staff_count')},
                  updated_at = NOW()
              WHERE id = ${sqlValue(runId, 'run_id')}
            `);
          }
        }
      } catch (err) {
        console.error('[payroll-update-hook] Failed to update payroll runs details:', err);
      }
    }

    const target = body.table ? resolveSchemaAndTable(body.schema, body.table) : null;
    if (
      target?.schema === 'public' &&
      target.table === 'customer_accounts' &&
      ['insert', 'upsert', 'update'].includes(operation)
    ) {
      await ensureB2bIdentityForOnboardingPayload(resultData?.length ? resultData : body.data);
    }

    // Prevent duplicate account names in journal.accounts
    if (target?.schema === 'journal' && target.table === 'accounts' && ['insert'].includes(operation)) {
      const name = (Array.isArray(body.data) ? body.data[0]?.name : body.data?.name);
      if (name) {
        const existing = await runManagementSql(
          `SELECT id FROM journal.accounts WHERE LOWER(name) = LOWER(${sqlValue(name)}) LIMIT 1`
        );
        const existingRows = parseSqlRows(existing);
        if (existingRows && existingRows.length > 0) {
          sendJson(res, 409, {
            data: null,
            error: `An account named "${name}" already exists. Please use a different name.`,
          });
          return;
        }
      }
    }

    if (['insert', 'upsert', 'update', 'delete'].includes(operation)) {
      // For order/purchase tables, AWAIT the fulfillment sync so insufficient-stock
      // errors propagate as 409. Other tables keep fire-and-forget for low latency.
      const isOrderTable = target?.schema === 'public'
        && ['retail_purchases', 'orders', 'customer_orders'].includes(target.table);
      if (isOrderTable && ['insert', 'upsert', 'update'].includes(operation)) {
        try {
          await awaitFulfillmentSync({ target, operation, data: body.data, resultData });
        } catch (allocErr) {
          if (allocErr?.code === 'INSUFFICIENT_FG_STOCK') {
            console.warn(`[ERP Supabase API] Rejected ${operation} on ${target.table}: ${allocErr.message}`);
            sendJson(res, allocErr.httpStatus || 409, {
              data: null,
              error: allocErr.message,
              code: 'INSUFFICIENT_FG_STOCK',
              product_name: allocErr.product_name,
              product_code: allocErr.product_code,
              requested: allocErr.requested,
              allocated: allocErr.allocated,
              short: allocErr.short,
              fulfillment_id: allocErr.fulfillment_id,
            });
            return;
          }
          throw allocErr;
        }
      } else {
        queueFulfillmentSync({
          target,
          operation,
          data: body.data,
          resultData,
        });
      }
    }

    if (['insert', 'upsert', 'update', 'delete'].includes(operation)) {
      if (target) {
        writeOperationLog({
          ...target,
          operation,
          data: body.data,
          filters: body.filters,
          resultData,
          user_email: body.user_email,
          user_role:  body.user_role,
        }).catch(() => {
          // Audit and alert rows are useful telemetry, but must not slow or fail user workflows.
        });
      }
    }

    sendJson(res, 200, {
      data: resultData || [],
      error: null,
    });
  } catch (error) {
    console.error(`[ERP Supabase API] ERROR: ${error.message}`);
    if (['select', 'raw'].includes(operation) && isNonFatalReadError(error)) {
      sendJson(res, 200, { data: [], error: null });
      return;
    }

    sendJson(res, 400, {
      data: null,
      error: error.message || String(error),
    });
  }
}

// ── Local upload (POST /api/uploads) ──────────────────────────────────────────
// Streams a single file from `multipart/form-data` to ./uploads/<category>/<date>/<ts>-<rand>-<safe-name>.
// Returns the same { data: { publicUrl, path, ... } } shape as the Supabase route
// so the frontend can swap endpoints without changing response handling.
function sanitizeFilename(name) {
  // Keep alphanumerics, dot, underscore, hyphen. Replace everything else with underscore.
  // Also prevent leading dots (hidden files) and empty results.
  const cleaned = String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(-120) || 'file';
}

function todayPrefix() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function handleUpload(req, res) {
  const ctype = String(req.headers['content-type'] || '');
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) {
    sendJson(res, 400, { data: null, error: 'Expected multipart/form-data' });
    return;
  }

  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: UPLOAD_MAX_BYTES } });
  } catch (err) {
    sendJson(res, 400, { data: null, error: `Invalid multipart headers: ${err.message}` });
    return;
  }

  let category = 'misc';
  let clientFilename = null;
  let savedFile = null;       // { relativePath, absPath, size, contentType }
  let rejectedReason = null;
  let sawFile = false;
  // Wait for the upload's write stream to flush before responding. busboy's
  // 'finish' fires when parsing is done, NOT when downstream writes complete,
  // so we need a separate promise resolved inside the file handler.
  let resolveFileWrite = () => {};
  const fileWritePromise = new Promise((resolve) => { resolveFileWrite = resolve; });
  let fileWriteSettled = false;
  const settleFileWrite = () => {
    if (fileWriteSettled) return;
    fileWriteSettled = true;
    resolveFileWrite();
  };
  let settled = false;

  const finish = (status, payload) => {
    if (settled) return;
    settled = true;
    // Detach busboy listeners so a late 'finish' from req doesn't double-fire.
    try { req.unpipe(busboy); } catch {}
    try { busboy.destroy(); } catch {}
    sendJson(res, status, payload);
  };

  busboy.on('field', (name, value) => {
    if (name === 'category') {
      const v = String(value || '').trim().toLowerCase();
      if (UPLOAD_ALLOWED_CATEGORIES.has(v)) category = v;
    } else if (name === 'filename' && value) {
      clientFilename = String(value);
    }
  });

  busboy.on('file', (_fieldname, fileStream, info) => {
    sawFile = true;
    const contentType = String(info.mimeType || info.mime || '').toLowerCase() || 'application/octet-stream';
    if (!mimeAllowedForCategory(category, contentType)) {
      rejectedReason = `Unsupported content type for [${category}]: ${contentType}`;
      fileStream.resume(); // drain
      settleFileWrite();
      return;
    }
    const safeBase = sanitizeFilename(info.filename || clientFilename || 'upload');
    const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const relDir = path.join(category, todayPrefix());
    const relPath = path.join(relDir, `${stamp}-${safeBase}`);
    const absDir = path.join(uploadsRoot, relDir);
    const absPath = path.join(uploadsRoot, relPath);

    // Defense in depth: relPath must stay under uploadsRoot.
    if (!absPath.startsWith(uploadsRoot + path.sep) && absPath !== uploadsRoot) {
      rejectedReason = 'Invalid storage path';
      fileStream.resume();
      settleFileWrite();
      return;
    }

    mkdir(absDir, { recursive: true })
      .then(() => {
        const out = createWriteStream(absPath);
        let written = 0;
        let truncated = false;
        fileStream.on('limit', () => {
          truncated = true;
          fileStream.unpipe(out);
          out.destroy();
        });
        fileStream.on('data', (chunk) => {
          written += chunk.length;
        });
        fileStream.pipe(out);
        out.on('finish', () => {
          if (truncated) {
            unlink(absPath).catch(() => {});
            rejectedReason = `File exceeds ${UPLOAD_MAX_BYTES} bytes`;
            settleFileWrite();
            return;
          }
          savedFile = { relativePath: relPath.split(path.sep).join('/'), absPath, size: written, contentType };
          settleFileWrite();
        });
        out.on('error', (err) => {
          rejectedReason = `Write failed: ${err.message}`;
          settleFileWrite();
        });
      })
      .catch((err) => {
        rejectedReason = `Could not create upload dir: ${err.message}`;
        fileStream.resume();
        settleFileWrite();
      });
  });

  busboy.on('error', (err) => {
    finish(400, { data: null, error: `Upload stream error: ${err.message}` });
  });

  req.on('aborted', () => {
    finish(499, { data: null, error: 'Client aborted upload' });
  });

  // Pipe request -> busboy, wait for parse, then wait for write-stream to flush.
  req.pipe(busboy);
  await new Promise((resolve) => {
    busboy.on('finish', () => {
      // If no file event ever fired (e.g., form-only submission), the file-write
      // promise would otherwise hang forever — settle it now. If a file event
      // DID fire, the file handler will settle it when the disk write completes.
      if (!sawFile) settleFileWrite();
      resolve();
    });
  });
  await fileWritePromise;

  if (settled) return; // already responded via error/abort paths
  if (rejectedReason) {
    finish(400, { data: null, error: rejectedReason });
    return;
  }
  if (!sawFile) {
    finish(400, { data: null, error: 'No file field in multipart body' });
    return;
  }
  if (!savedFile) {
    finish(400, { data: null, error: 'Upload did not complete' });
    return;
  }

  const publicUrl = `/${UPLOAD_DIR_NAME}/${savedFile.relativePath}`;
  finish(200, {
    data: {
      bucket: category,
      path: savedFile.relativePath,
      publicUrl,
      size: savedFile.size,
      contentType: savedFile.contentType,
    },
    error: null,
  });
}

// ── Local upload delete (DELETE /api/uploads) ─────────────────────────────────
async function handleUploadDelete(req, res) {
  try {
    const body = await readJsonBody(req);
    const requested = String(body.path || '').replace(/^\/+/, '').replace(/\\/g, '/');
    if (!requested) {
      sendJson(res, 400, { data: null, error: 'path is required' });
      return;
    }
    const abs = path.join(uploadsRoot, requested);
    if (!abs.startsWith(uploadsRoot + path.sep)) {
      sendJson(res, 400, { data: null, error: 'Invalid path' });
      return;
    }
    await unlink(abs);
    sendJson(res, 200, { data: { path: requested, deleted: true }, error: null });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      sendJson(res, 404, { data: null, error: 'File not found' });
      return;
    }
    sendJson(res, 400, { data: null, error: err.message || String(err) });
  }
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let requestedPath = decodeURIComponent(url.pathname);

  if (requestedPath === '/') requestedPath = '/index.html';

  // ── Page-access gate (only for HTML staff pages; not for assets/API/customer pages)
  // Public pages and assets skip this check entirely. Staff pages not in the
  // page_id map are also allowed through (defensive — better to over-serve a
  // page than to lock out admins by accident).
  const ext = path.extname(requestedPath.split('?')[0]).toLowerCase();
  if (ext === '' || ext === '.html') {
    const pageId = pageIdFromPath(requestedPath);
    if (pageId) {
      // Staff session is optional for public assets, but for a gated page we
      // need a known role. If no session, the client guardPage will handle it
      // by redirecting to /index.html; here we just allow through to keep
      // the SPA flow intact.
      const session = readStaffSessionFromRequest(req);
      if (session) {
        const allowed = await effectiveCanOpenPage(pageId, session.role);
        if (!allowed) {
          sendJson(res, 403, {
            error: 'Forbidden',
            message: `Your role "${session.role}" is not permitted to access this page.`,
            pageId,
          });
          return;
        }
      }
    }
  }

  // Resolve the requested path against rootDir and verify the resolved
  // location stays inside rootDir. This blocks `..` traversal escaping the
  // project root (e.g. `/etc/passwd`).
  const safePath = requestedPath.replace(/^\/+/, '');
  const filePath = path.resolve(rootDir, safePath);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;

  if (!filePath.startsWith(rootWithSep) && filePath !== rootDir) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  // /uploads/* is only allowed to resolve inside the uploads folder.
  // This prevents serving arbitrary project files via a crafted URL.
  // (Node's HTTP parser already collapses `..` before we see it, so this is
  // belt-and-suspenders against any future routing change.)
  if (requestedPath.startsWith(`/${UPLOAD_DIR_NAME}/`) || requestedPath === `/${UPLOAD_DIR_NAME}`) {
    const uploadsWithSep = uploadsRoot.endsWith(path.sep) ? uploadsRoot : uploadsRoot + path.sep;
    if (!filePath.startsWith(uploadsWithSep) && filePath !== uploadsRoot) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = path.join(filePath, 'index.html');

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes.get(ext) || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    try {
      const indexPath = path.join(rootDir, 'index.html');
      const html = await readFile(indexPath, 'utf8');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      sendJson(res, 404, { error: 'Not found' });
    }
  }
}

export async function handleRequest(req, res, options = {}) {
  const { serveStatic = true } = options;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      supabaseConfigured: Boolean(supabaseAdmin),
      sqlProxyConfigured,
      projectRef: supabaseProjectRef || null,
    });
    return;
  }

  // ─── RBAC admin endpoints ─────────────────────────────────────────────────
  // All require a logged-in staff session with role='admin'. The DB enforces
  // the same rule (CHECK role<>'admin' on rbac_overrides/rbac_page_access),
  // but the API guard gives a friendlier error than a 23514 violation.

  // GET /api/rbac/effective — merged matrix used by client + server checks.
  // Response shape:
  //   { matrix: { 'inventory:read': ['admin','accountant',...] }, roles: [...] }
  // The client caches this in sessionStorage; the server caches it in
  // effectiveRbacCache (30s TTL, invalidated on every PUT).
  if (url.pathname === '/api/rbac/effective' && req.method === 'GET') {
    const session = readStaffSessionFromRequest(req);
    if (!session) { sendJson(res, 401, { error: 'Not authenticated' }); return; }
    try {
      await getEffectiveRbac(); // warms the cache
      sendJson(res, 200, {
        ok: true,
        matrix: effectiveMatrix(),
        roles: STAFF_ROLES,
        source: effectiveRbacCache?.source || 'defaults',
        loadedAt: effectiveRbacCache?.loadedAt || Date.now(),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // GET /api/rbac/permissions — raw permission overrides (for the admin UI).
  if (url.pathname === '/api/rbac/permissions' && req.method === 'GET') {
    if (!requireStaffAdmin(req, res)) return;
    try {
      const before = await snapshotRbacState();
      sendJson(res, 200, { ok: true, overrides: before.rows });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // PUT /api/rbac/permissions — replace the override set with the supplied
  // list. Body: { changes: [{ permission_key, role, value }], reason?: string }
  // Internally: takes a snapshot, deletes all existing override rows not in
  // the new set, upserts the rest, snapshots again, writes rbac_history.
  if (url.pathname === '/api/rbac/permissions' && req.method === 'PUT') {
    const session = requireStaffAdmin(req, res);
    if (!session) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) {
      sendJson(res, 400, { error: 'Invalid JSON body' }); return;
    }
    const incoming = Array.isArray(body.changes) ? body.changes : [];
    const safe = incoming.filter((c) => c && c.permission_key && c.role && c.role !== 'admin');
    try {
      const before = await snapshotRbacState();
      // Delete everything currently in the table, then re-insert from `safe`.
      // Simpler than computing a diff and gives us a clean audit snapshot.
      if (sqlProxyConfigured && !sqlProxyDisabled) {
        await runManagementSql('DELETE FROM public.rbac_overrides;');
        await writeRbacOverrides(safe.map((c) => ({
          permission_key: c.permission_key,
          role: c.role,
          value: !!c.value,
          updated_by: session.email || 'admin',
        })));
      }
      invalidateEffectiveRbacCache();
      const after = await snapshotRbacState();
      const summary = (body.reason || '').trim() ||
        `Bulk update: ${safe.length} override${safe.length === 1 ? '' : 's'} by ${session.email}`;
      if (sqlProxyConfigured && !sqlProxyDisabled) {
        const esc = (s) => String(s ?? '').replace(/'/g, "''");
        const jsonEsc = (o) => JSON.stringify(o).replace(/'/g, "''");
        await runManagementSql(
          `INSERT INTO public.rbac_history (saved_by, summary, snapshot_before, snapshot_after)
           VALUES ('${esc(session.email || 'admin')}', '${esc(summary)}',
                   '${jsonEsc(before)}'::jsonb, '${jsonEsc(after)}'::jsonb);`
        );
      }
      sendJson(res, 200, { ok: true, count: safe.length, summary });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // GET /api/rbac/history — past snapshots, newest first, capped at 50.
  if (url.pathname === '/api/rbac/history' && req.method === 'GET') {
    if (!requireStaffAdmin(req, res)) return;
    try {
      if (!sqlProxyConfigured || sqlProxyDisabled) {
        sendJson(res, 200, { ok: true, rows: [], note: 'sql proxy not configured' });
        return;
      }
      const rows = await runManagementSql(
        'SELECT id, saved_at, saved_by, summary, snapshot_before, snapshot_after FROM public.rbac_history ORDER BY id DESC LIMIT 50'
      );
      sendJson(res, 200, { ok: true, rows: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // POST /api/rbac/history/:id/restore — replace current overrides with the
  // snapshot_after of the given history row, then write a new history row
  // describing the restore.
  if (url.pathname.startsWith('/api/rbac/history/') && url.pathname.endsWith('/restore') && req.method === 'POST') {
    const session = requireStaffAdmin(req, res);
    if (!session) return;
    const idStr = url.pathname.slice('/api/rbac/history/'.length, -'/restore'.length);
    const historyId = parseInt(idStr, 10);
    if (!Number.isInteger(historyId) || historyId <= 0) {
      sendJson(res, 400, { error: 'Invalid history id' }); return;
    }
    try {
      if (!sqlProxyConfigured || sqlProxyDisabled) {
        sendJson(res, 503, { ok: false, error: 'sql proxy not configured' });
        return;
      }
      const rows = await runManagementSql(
        `SELECT snapshot_after FROM public.rbac_history WHERE id = ${historyId} LIMIT 1`
      );
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) { sendJson(res, 404, { ok: false, error: 'history row not found' }); return; }
      const snap = row.snapshot_after || { rows: [] };
      const list = Array.isArray(snap.rows) ? snap.rows : [];
      const before = await snapshotRbacState();
      await runManagementSql('DELETE FROM public.rbac_overrides;');
      await writeRbacOverrides(list.map((r) => ({
        permission_key: r.permission_key,
        role: r.role,
        value: !!r.value,
        updated_by: session.email || 'admin',
      })));
      invalidateEffectiveRbacCache();
      const after = await snapshotRbacState();
      const summary = `Restored from history #${historyId} by ${session.email}`;
      const esc = (s) => String(s ?? '').replace(/'/g, "''");
      const jsonEsc = (o) => JSON.stringify(o).replace(/'/g, "''");
      await runManagementSql(
        `INSERT INTO public.rbac_history (saved_by, summary, snapshot_before, snapshot_after)
         VALUES ('${esc(session.email || 'admin')}', '${esc(summary)}',
                 '${jsonEsc(before)}'::jsonb, '${jsonEsc(after)}'::jsonb);`
      );
      sendJson(res, 200, { ok: true, count: list.length, summary });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // ─── Page-access endpoints (mirror of the permission endpoints) ───────────
  // GET /api/rbac/page-access — list every per-(page_id, role) override.
  if (url.pathname === '/api/rbac/page-access' && req.method === 'GET') {
    if (!requireStaffAdmin(req, res)) return;
    try {
      if (!sqlProxyConfigured || sqlProxyDisabled) {
        sendJson(res, 200, { ok: true, rows: [] });
        return;
      }
      const rows = await runManagementSql(
        'SELECT page_id, role, granted, updated_at, updated_by FROM public.rbac_page_access ORDER BY page_id, role'
      );
      sendJson(res, 200, { ok: true, rows: Array.isArray(rows) ? rows : [] });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // PUT /api/rbac/page-access — bulk replace page overrides. Same shape as
  // the permission PUT (deltas only on the client; we replace the whole table
  // server-side to keep the audit trail simple).
  if (url.pathname === '/api/rbac/page-access' && req.method === 'PUT') {
    const session = requireStaffAdmin(req, res);
    if (!session) return;
    let body;
    try { body = await readJsonBody(req); } catch (e) {
      sendJson(res, 400, { error: 'Invalid JSON body' }); return;
    }
    const incoming = Array.isArray(body.changes) ? body.changes : [];
    const safe = incoming.filter((c) => c && c.page_id && c.role && c.role !== 'admin');
    try {
      if (!sqlProxyConfigured || sqlProxyDisabled) {
        sendJson(res, 503, { ok: false, error: 'sql proxy not configured' });
        return;
      }
      await runManagementSql('DELETE FROM public.rbac_page_access;');
      if (safe.length > 0) {
        const esc = (s) => String(s ?? '').replace(/'/g, "''");
        const values = safe.map((r) => {
          return `('${esc(r.page_id)}', '${esc(r.role)}', ${r.granted === false ? 'false' : 'true'}, now(), '${esc(session.email || 'admin')}')`;
        }).join(',\n  ');
        await runManagementSql(
          `INSERT INTO public.rbac_page_access (page_id, role, granted, updated_at, updated_by)
           VALUES ${values}
           ON CONFLICT (page_id, role) DO UPDATE SET
             granted = EXCLUDED.granted,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by;`
        );
      }
      invalidateEffectivePageAccessCache();
      const summary = (body.reason || '').trim() ||
        `Page access bulk update: ${safe.length} row${safe.length === 1 ? '' : 's'} by ${session.email}`;
      sendJson(res, 200, { ok: true, count: safe.length, summary });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
    return;
  }

  // Debug endpoint to test SQL proxy
  if (url.pathname === '/api/debug-sql' && req.method === 'GET') {
    try {
      const result = await runManagementSql('SELECT COUNT(*) as cnt FROM journal.ledger');
      sendJson(res, 200, { ok: true, result });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message, sqlProxyConfigured, projectRef: supabaseProjectRef });
    }
    return;
  }

  if (url.pathname === '/api/supabase' && req.method === 'POST') {
    await handleSupabaseApi(req, res);
    return;
  }

  // GET /api/payroll/stages — returns the current stage for each visible cycle.
  // Used by the UI cycle dropdown to show "(Draft)", "(Adjustment)", "(Locked)",
  // or "(Paid / Locked)" tags alongside each option.
  if (url.pathname === '/api/payroll/stages' && req.method === 'GET') {
    try {
      const settings = await getCompanySettings();
      const payDay = settings.pay_day || 25;
      const adjustmentDays = settings.payroll_adjustment_days ?? 7;
      const lockHour = settings.payroll_lock_hour ?? 23;
      const lockMin = settings.payroll_lock_min ?? 59;

      // Build the same window used by the UI: prev, current, next two months
      const monthNames = ['January','February','March','April','May','June',
                          'July','August','September','October','November','December'];
      const now = new Date();
      const cycles = [];
      for (let i = -1; i <= 2; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        cycles.push(`${monthNames[d.getMonth()]} ${d.getFullYear()}`);
      }

      // Check which cycles already have a payroll_runs row (finalized)
      const paidSet = new Set();
      try {
        const runRows = parseSqlRows(
          await runManagementSql(`SELECT cycle FROM public.payroll_runs WHERE cycle = ANY(${sqlValue(cycles, 'text[]')})`)
        );
        (runRows || []).forEach(r => paidSet.add(r.cycle));
      } catch (_) { /* sql proxy may not be ready yet */ }

      const stages = {};
      for (const cycleLabel of cycles) {
        if (paidSet.has(cycleLabel)) {
          stages[cycleLabel] = 'Paid';
        } else {
          stages[cycleLabel] = getCycleStage(cycleLabel);
        }
      }

      sendJson(res, 200, {
        ok: true,
        payDay,
        adjustmentDays,
        lockHour,
        lockMin,
        stages,
        settings: {
          pay_day: payDay,
          payroll_adjustment_days: adjustmentDays,
          payroll_lock_hour: lockHour,
          payroll_lock_min: lockMin,
        },
      });
    } catch (err) {
      console.error('[payroll-stages]', err.message);
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  // ── Generic migration endpoint for schema setup ───────────────────────────────
  if (url.pathname === '/api/migrate' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const body = await readJsonBody(req);
      const { query } = body;
      if (!query || typeof query !== 'string') {
        sendJson(res, 400, { error: 'SQL query is required' });
        return;
      }
      const result = await runManagementSql(query);
      sendJson(res, 200, { data: result, error: null });
    } catch (err) {
      sendJson(res, 500, { data: null, error: err.message });
    }
    return;
  }

  // ── Admin DDL endpoint — safe, controlled schema migrations ──
  if (url.pathname === '/api/admin/ddl' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const { query } = body;
      if (!query || typeof query !== 'string') {
        sendJson(res, 400, { error: 'query string is required' });
        return;
      }
      const trimmed = query.trim();
      if (!/^(alter|create|drop|truncate|grant|revoke)\b/i.test(trimmed)) {
        sendJson(res, 400, { error: 'Only DDL (ALTER, CREATE, DROP, TRUNCATE, GRANT, REVOKE) is allowed' });
        return;
      }
      if (trimmed.includes(';')) {
        sendJson(res, 400, { error: 'Only one statement at a time' });
        return;
      }
      const result = await runManagementSql(trimmed);
      sendJson(res, 200, { data: result, error: null });
    } catch (err) {
      sendJson(res, 500, { data: null, error: err.message });
    }
    return;
  }

  // ── Secure DDL endpoint for schema migrations (chat tables only) ──
  if (url.pathname === '/api/ddl' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const allowedTables = ['chat_channels', 'chat_messages', 'chat_participants'];
      const createPattern = /^create\s+(unique\s+)?index\s+(if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:project\.)?(\w+)\s*\(/i;
      const createMatch = String(body.query || '').match(createPattern);
      if (createMatch) {
        const tableName = createMatch[4].toLowerCase();
        if (!allowedTables.includes(tableName)) {
          sendJson(res, 400, { error: `Table "${tableName}" not allowed. Only: ${allowedTables.join(', ')}` });
          return;
        }
        const result = await runManagementSql(String(body.query));
        sendJson(res, 200, { data: result, error: null });
        return;
      }
      sendJson(res, 400, { error: 'Only CREATE INDEX on chat tables is allowed via /api/ddl' });
    } catch (err) {
      sendJson(res, 500, { data: null, error: err.message });
    }
    return;
  }

  // ── Outreach bootstrap: idempotent multi-statement DDL for the outreach tables
  // The existing /api/admin/ddl endpoint rejects any query containing a semicolon,
  // which is fine for one-shot migrations but tedious for the 8-statement outreach
  // setup. This endpoint runs the pre-approved outreach DDL block in a single
  // round-trip. Safe to call repeatedly — every statement is IF NOT EXISTS / OR REPLACE.
  if (url.pathname === '/api/outreach/bootstrap' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      // NOTE: outreach_campaigns already exists with a uuid PK and a different
      // column set (target_count / sent_count / open_count / click_count). We
      // do NOT recreate it. The dispatch log + suppression list are new tables.
      const ddl = `
        CREATE TABLE IF NOT EXISTS public.outreach_dispatch_log (
          id                   bigserial PRIMARY KEY,
          campaign_id          uuid REFERENCES public.outreach_campaigns(id) ON DELETE SET NULL,
          recipient_email      text,
          status               text NOT NULL DEFAULT 'queued',
          provider             text DEFAULT 'brevo',
          provider_message_id  text,
          error_message        text,
          attempted_at         timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE public.outreach_dispatch_log DISABLE ROW LEVEL SECURITY;
        CREATE INDEX IF NOT EXISTS idx_outreach_dispatch_log_campaign_id
          ON public.outreach_dispatch_log (campaign_id);
        CREATE INDEX IF NOT EXISTS idx_outreach_dispatch_log_recipient
          ON public.outreach_dispatch_log (recipient_email);
        CREATE TABLE IF NOT EXISTS public.outreach_unsubscribes (
          id              bigserial PRIMARY KEY,
          email           text NOT NULL UNIQUE,
          source_campaign uuid REFERENCES public.outreach_campaigns(id) ON DELETE SET NULL,
          unsubscribed_at timestamptz NOT NULL DEFAULT now(),
          reason          text
        );
        ALTER TABLE public.outreach_unsubscribes DISABLE ROW LEVEL SECURITY;
      `;
      const result = await runManagementSql(ddl);
      sendJson(res, 200, { ok: true, sandbox: OUTREACH_SANDBOX_MODE, result });
    } catch (err) {
      console.error('[/api/outreach/bootstrap]', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── POST /api/support/notify-customer ──────────────────────────────────────────
  // Fires when a staff sends a reply in the Support Hub. Does three things:
  //   1. Persists chat_channels.last_message_at so the DB is fresh
  //   2. Looks up the customer's email from the channel (via order_id or participants)
  //   3. Sends a Brevo SMTP notification email to the customer
  if (url.pathname === '/api/support/notify-customer' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const {
        channelId,
        channelType,   // 'b2c_customer' | 'b2b_customer'
        orderId,
        customerName,
        customerEmail,
        staffName,
        messageText,
        channelName,
      } = body || {};

      if (!channelId || !messageText) {
        sendJson(res, 400, { error: 'channelId and messageText are required' });
        return;
      }

      const now = new Date().toISOString();

      // 1. Update channel last_message_at
      try {
        await supabaseAdmin
          .from('chat_channels')
          .update({ last_message_at: now })
          .eq('id', channelId);
      } catch (e) {
        console.warn('[/api/support/notify-customer] failed to update last_message_at:', e?.message || e);
      }

      // 2. Resolve customer email: prefer explicit field, then look up from order
      let resolvedEmail = (customerEmail || '').trim().toLowerCase();
      let resolvedName  = (customerName  || channelName || 'Customer').trim();

      if (!resolvedEmail && orderId) {
        const tables = channelType === 'b2b_customer'
          ? ['wholesale_purchases', 'corporate_orders']
          : ['retail_purchases', 'pos_orders'];
        for (const tbl of tables) {
          try {
            const { data: rows } = await supabaseAdmin
              .from(tbl)
              .select('customer_email, customer_name')
              .or(`order_id.ilike.${orderId},id.ilike.${orderId}`)
              .limit(1);
            if (rows?.length) {
              resolvedEmail = (rows[0].customer_email || '').trim().toLowerCase();
              resolvedName = (rows[0].customer_name   || resolvedName).trim();
              if (resolvedEmail) break;
            }
          } catch (_) { /* fall through */ }
        }
      }

      if (!resolvedEmail) {
        sendJson(res, 200, { ok: true, notified: false, reason: 'no_email' });
        return;
      }

      // 3. Send Brevo notification
      const transporter = getBrevoTransporter();
      const fromValue  = resolveOutreachFromAddress(channelType === 'b2b_customer' ? 'b2b' : 'b2c');
      const replyTo    = BREVO_REPLY_TO || undefined;
      const subject    = `${resolvedName} · Espressgo Support replied to your order`;
      const preview    = messageText.length > 120
        ? messageText.slice(0, 117).trimEnd() + '…'
        : messageText;
      const ts = new Date(now).toLocaleString('en-SG', {
        dateStyle: 'medium', timeStyle: 'short',
      });

      const htmlBody = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;
              box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#4f46e5;padding:28px 32px;">
      <p style="margin:0;font-size:20px;font-weight:bold;color:#ffffff;line-height:1.3;">Espressgo Support</p>
      <p style="margin:6px 0 0;font-size:13px;color:#c7d2fe;">You have a new reply regarding your order</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="margin:0 0 20px;font-size:15px;color:#1e293b;line-height:1.6;">
        Hi <strong>${escapeHtml(resolvedName)}</strong>,
      </p>
      <p style="margin:0 0 6px;font-size:13px;font-weight:bold;color:#64748b;letter-spacing:0.5px;uppercase;">
        ${escapeHtml(staffName || 'Espressgo Support')} replied on ${ts}
      </p>
      <div style="background:#f8fafc;border-left:4px solid #4f46e5;border-radius:0 8px 8px 0;
                  padding:14px 18px;margin:0 0 24px;">
        <p style="margin:0;font-size:14px;color:#334155;line-height:1.7;white-space:pre-wrap;word-break:break-word;">
          ${escapeHtml(preview)}
        </p>
      </div>
      <p style="margin:0 0 6px;font-size:13px;color:#64748b;line-height:1.5;">
        Log in to your account to read the full reply and continue the conversation.
      </p>
    </div>
    <div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;">
      <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">
        This is an automated message from Espressgo.<br>Please do not reply to this email directly.
      </p>
    </div>
  </div>
</body>
</html>`;

      if (!transporter || OUTREACH_SANDBOX_MODE) {
        if (OUTREACH_SANDBOX_MODE) {
          console.log(`[support notify] SANDBOX — would email ${resolvedEmail}: "${preview.slice(0, 60)}"`);
        }
        sendJson(res, 200, { ok: true, notified: false, reason: transporter ? 'sandbox' : 'no_transporter' });
        return;
      }

      try {
        await transporter.sendMail({
          from:    fromValue || undefined,
          replyTo,
          to:      resolvedEmail,
          subject,
          html:    htmlBody,
          headers: { 'X-Espressgo-Support': '1' },
        });
        sendJson(res, 200, { ok: true, notified: true, email: resolvedEmail });
      } catch (mailErr) {
        console.error('[/api/support/notify-customer] sendMail failed:', mailErr?.message || mailErr);
        sendJson(res, 200, { ok: true, notified: false, reason: 'mail_error' });
      }
    } catch (err) {
      console.error('[/api/support/notify-customer]', err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/support/ai-reply/:channelId ────────────────────────────────────
  // Fires after every customer message in a channel. Builds an order-scoped
  // prompt, calls OpenRouter, and (if the safety gate passes) inserts the
  // reply into chat_messages as a staff message. The customer sees it as
  // coming from staff; the Support Hub sees an `is_ai: true` flag on the row.
  //
  // Body: { customerMessageId, customerMessageText, orderId }
  if (url.pathname.startsWith('/api/support/ai-reply/') && req.method === 'POST') {
    if (!OPENROUTER_API_KEY) {
      sendJson(res, 503, { ok: false, error: 'OPENROUTER_API_KEY not configured' });
      return;
    }

    const channelId = url.pathname.split('/').pop();
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }

    const { customerMessageId, customerMessageText, orderId } = body || {};
    if (!channelId || !customerMessageId || !customerMessageText) {
      sendJson(res, 400, { ok: false, error: 'channelId, customerMessageId, customerMessageText required' });
      return;
    }

    try {
      const result = await generateAiStaffReply({
        channelId,
        customerMessageId,
        customerMessageText: String(customerMessageText),
        orderId: orderId ? String(orderId) : null,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error('[/api/support/ai-reply]', err);
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  // ── POST /api/customer-verification/notify-decision ───────────────────────────
  // Called by the B2B Customer Verification page right after the manager clicks
  // Approve or Reject. Sends an email to the customer (using their account email)
  // letting them know the outcome so they can log in and act on it. Designed to
  // be best-effort: the DB update is the source of truth — if the email fails
  // we still return 200 with `notified:false` so the UI doesn't block on it.
  // Body:
  //   {
  //     decision: 'approve' | 'reject',
  //     companyName, customerEmail, reason? (for rejections), businessId?
  //   }
  if (url.pathname === '/api/customer-verification/notify-decision' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const decision  = String(body?.decision || '').toLowerCase();
      const email     = String(body?.customerEmail || '').trim().toLowerCase();
      const company   = String(body?.companyName || '').trim() || 'Customer';
      const reason    = String(body?.reason || '').trim();
      const businessId = String(body?.businessId || '').trim();

      if (!email) {
        sendJson(res, 200, { ok: true, notified: false, reason: 'no_email' });
        return;
      }
      if (decision !== 'approve' && decision !== 'reject') {
        sendJson(res, 400, { ok: false, error: 'decision must be "approve" or "reject"' });
        return;
      }

      const transporter = getBrevoTransporter();
      const fromValue = resolveOutreachFromAddress('b2b');
      const replyTo   = BREVO_REPLY_TO || undefined;

      const isApproved = decision === 'approve';
      const subject = isApproved
        ? `Welcome aboard, ${company} — your B2B account is verified`
        : `${company} · Update on your B2B verification request`;

      const accent     = isApproved ? '#10B981' : '#EF4444';
      const headline   = isApproved ? 'You’re Verified' : 'Verification Update';
      const subhead    = isApproved
        ? 'Your B2B account has been approved.'
        : 'Your verification request was not approved this round.';
      const portalLine = isApproved
        ? 'You can now sign in to your B2B portal, place orders, and access wholesale pricing.'
        : 'Please review the note below and re-submit any documents or information that were missing.';

      const reasonBlock = (!isApproved && reason)
        ? `
          <p style="margin:0 0 8px;font-size:12px;font-weight:bold;color:#64748b;letter-spacing:0.5px;uppercase;">Reason from reviewer</p>
          <div style="background:#fff7ed;border-left:4px solid #f97316;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 24px;">
            <p style="margin:0;font-size:14px;color:#7c2d12;line-height:1.7;white-space:pre-wrap;word-break:break-word;">
              ${escapeHtml(reason)}
            </p>
          </div>
        `
        : '';

      const nextStep = isApproved
        ? `<p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Need help getting started? Reply to this email or open a chat in the portal — our team is on standby.</p>`
        : `<p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Log in to your portal to see what was missing, and re-submit. Most issues are resolved within 24 hours.</p>`;

      const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;
              box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:${accent};padding:28px 32px;">
      <p style="margin:0;font-size:20px;font-weight:bold;color:#ffffff;line-height:1.3;">Espressgo · B2B Verification</p>
      <p style="margin:6px 0 0;font-size:13px;color:${isApproved ? '#d1fae5' : '#fee2e2'};">${escapeHtml(subhead)}</p>
    </div>
    <div style="padding:28px 32px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#64748b;letter-spacing:0.5px;uppercase;">${escapeHtml(headline)}</p>
      <h2 style="margin:0 0 16px;font-size:22px;font-weight:bold;color:#0f172a;line-height:1.3;">Hi ${escapeHtml(company)},</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.7;">
        ${escapeHtml(portalLine)}
      </p>
      ${reasonBlock}
      ${nextStep}
      ${businessId ? `<p style="margin:24px 0 0;font-size:11px;color:#94a3b8;">Reference ID: ${escapeHtml(businessId)}</p>` : ''}
    </div>
    <div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;">
      <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">
        You’re receiving this because ${escapeHtml(company)} has a B2B verification record with Espressgo.<br>
        Please do not reply to this email directly — use the in-portal support chat for assistance.
      </p>
    </div>
  </div>
</body>
</html>`;

      if (!transporter || OUTREACH_SANDBOX_MODE) {
        if (OUTREACH_SANDBOX_MODE) {
          console.log(`[verification notify] SANDBOX — would email ${email} (decision=${decision}, company="${company}")`);
        }
        sendJson(res, 200, {
          ok: true,
          notified: false,
          reason: transporter ? 'sandbox' : 'no_transporter',
        });
        return;
      }

      try {
        await transporter.sendMail({
          from:    fromValue || undefined,
          replyTo,
          to:      email,
          subject,
          html:    htmlBody,
          headers: { 'X-Espressgo-Verification-Decision': decision },
        });
        sendJson(res, 200, { ok: true, notified: true, email });
      } catch (mailErr) {
        console.error('[/api/customer-verification/notify-decision] sendMail failed:', mailErr?.message || mailErr);
        sendJson(res, 200, { ok: true, notified: false, reason: 'mail_error' });
      }
    } catch (err) {
      console.error('[/api/customer-verification/notify-decision]', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Outreach status: lightweight health check used by the email-outreach UI ──
  if (url.pathname === '/api/outreach/status' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      sandbox: OUTREACH_SANDBOX_MODE,
      brevoMailerConfigured,
      fromConfigured: {
        b2c: Boolean(BREVO_FROM_B2C),
        b2b: Boolean(BREVO_FROM_B2B),
      },
      replyToConfigured: Boolean(BREVO_REPLY_TO),
      maxRecipientsPerRun: OUTREACH_MAX_RECIPIENTS_PER_RUN,
      delayBetweenMs: OUTREACH_DELAY_BETWEEN_MS,
    });
    return;
  }

  // ── Supplier quotation bootstrap: idempotent DDL for the price_date /
  // is_active columns used by the supplier-details page. The frontend inserts
  // these via the anon Supabase client, so the columns must exist or the
  // insert is rejected and the row silently disappears.
  if (url.pathname === '/api/supplier/quotation/bootstrap' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const ddl = `
        ALTER TABLE public.supplier_quotations
          ADD COLUMN IF NOT EXISTS price_date date,
          ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
      `;
      const result = await runManagementSql(ddl);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      console.error('[/api/supplier/quotation/bootstrap]', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Supplier PO email bootstrap: idempotent DDL for the audit columns used by
  // /api/supplier/send-po-email. email_sent / email_sent_at are already read by
  // the supplier-details page, so they exist on raw_material_orders; we still
  // add email_recipient / email_error on best-effort for richer audit logs.
  if (url.pathname === '/api/supplier/po-email/bootstrap' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const ddl = `
        ALTER TABLE public.raw_material_orders
          ADD COLUMN IF NOT EXISTS email_recipient text,
          ADD COLUMN IF NOT EXISTS email_error text;
      `;
      const result = await runManagementSql(ddl);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      console.error('[/api/supplier/po-email/bootstrap]', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Supplier PO email: notify the supplier that a PO was just created ──────────
  // Called by the PO creation flows in details.html (single-item) and
  // inventory.html (multi-line) immediately after purchase_records +
  // raw_material_orders are inserted. Always returns 200 with a structured
  // result so the calling UI can decide whether to surface a non-blocking
  // warning — the PO itself is already persisted and is not rolled back if
  // the email fails or the supplier has no email on file.
  //
  // Behavior:
  //   * Looks up supplier_main_point_of_contact_email from public.suppliers
  //     (the same field the supplier-details page already renders).
  //   * When OUTREACH_SANDBOX_MODE=true (default), no SMTP connection is
  //     opened. The endpoint still flips raw_material_orders.email_sent to
  //     true and stamps email_sent_at so the supplier PO list shows the
  //     notification as "delivered (sandbox)" — matching the existing UI
  //     read-side expectations at details.html:909.
  //   * When OUTREACH_SANDBOX_MODE=false, each row under the same po_number
  //     is sent through the Brevo SMTP relay and the result is logged via
  //     the existing outreach_dispatch_log table.
  if (url.pathname === '/api/supplier/send-po-email' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const {
        supplierId = null,
        supplierName = '',
        poNumber = '',
        purchaseRecordId = null,
        items: rawItems = [],
        totalAmount = 0,
        currency = 'USD',
        purchaseDate = null,
        notes = '',
        contactName = '',
      } = body || {};

      if (!poNumber || typeof poNumber !== 'string') {
        sendJson(res, 400, { ok: false, error: 'poNumber is required' });
        return;
      }
      if (!supplierId) {
        sendJson(res, 400, { ok: false, error: 'supplierId is required' });
        return;
      }

      // Look up the supplier's contact email from the same column the
      // supplier-details page already reads (supplier_main_point_of_contact_email).
      let supplierEmail = '';
      try {
        const supplierRows = await selectSql({
          schema: 'public',
          table: 'suppliers',
          columns: 'supplier_id, supplier_company, supplier_main_point_of_contact_email, supplier_main_point_of_contact_name',
          filters: { eq: { supplier_id: supplierId } },
        });
        const row = Array.isArray(supplierRows) && supplierRows.length > 0 ? supplierRows[0] : null;
        supplierEmail = String(row?.supplier_main_point_of_contact_email || '').trim();
      } catch (lookupErr) {
        console.warn('[/api/supplier/send-po-email] supplier lookup failed:', lookupErr?.message || lookupErr);
      }

      // No email on file — record this honestly so the PO list shows the
      // "schedule" icon and operators know the supplier record needs an
      // email before real dispatch will work.
      if (!supplierEmail || !supplierEmail.includes('@')) {
        try {
          await updateSql({
            schema: 'public',
            table: 'raw_material_orders',
            data: [{
              email_sent: false,
              email_sent_at: null,
              email_error: 'No supplier_main_point_of_contact_email on file',
            }],
            filters: { eq: { order_number: poNumber } },
          });
        } catch (markErr) {
          console.warn('[/api/supplier/send-po-email] could not flag missing email:', markErr?.message || markErr);
        }
        sendJson(res, 200, {
          ok: false,
          skipped: true,
          reason: 'no_supplier_email',
          message: 'Supplier has no email on file; PO was created but no notification was sent.',
        });
        return;
      }

      const safeItems = Array.isArray(rawItems) ? rawItems : [];
      const formattedTotal = Number(totalAmount || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const itemRowsHtml = safeItems.map((line, idx) => {
        const qty = Number(line.quantity || 0).toLocaleString();
        const unit = escapeHtml(String(line.unit || 'units'));
        const name = escapeHtml(String(line.item_name || line.item_code || `Item ${idx + 1}`));
        const code = line.item_code ? ` <span style="color:#78716c;">(${escapeHtml(String(line.item_code))})</span>` : '';
        const unitCost = Number(line.unit_cost || 0).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const lineTotal = Number(line.line_total || (Number(line.quantity || 0) * Number(line.unit_cost || 0))).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        return `<tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;">${name}${code}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;text-align:right;">${qty} ${unit}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;text-align:right;">${currency} ${unitCost}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;text-align:right;font-weight:600;">${currency} ${lineTotal}</td>
        </tr>`;
      }).join('');

      const todayStr = purchaseDate || new Date().toISOString().slice(0, 10);
      const greetingName = escapeHtml(contactName || 'Supplier team');
      const safeSupplierName = escapeHtml(supplierName || 'Supplier');
      const safePoNumber = escapeHtml(poNumber);
      const safeNotes = notes ? `<p style="margin:18px 0 0;color:#44403c;line-height:1.5;">${escapeHtml(String(notes))}</p>` : '';
      const referenceBlock = purchaseRecordId
        ? `<p style="margin:0 0 6px;color:#78716c;font-size:12px;">Reference: ${escapeHtml(String(purchaseRecordId))}</p>`
        : '';

      const htmlInner = `
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden;">
  <div style="background:#1c1917;color:#fafaf9;padding:20px 24px;">
    <p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#a8a29e;">EspressGo — Purchase Order</p>
    <h1 style="margin:6px 0 0;font-size:20px;font-weight:600;">${safePoNumber}</h1>
  </div>
  <div style="padding:24px;color:#1c1917;font-size:14px;line-height:1.55;">
    <p style="margin:0 0 12px;">Hello ${greetingName},</p>
    <p style="margin:0 0 18px;">A new purchase order has been issued to <strong>${safeSupplierName}</strong> on <strong>${escapeHtml(todayStr)}</strong>. Please review the line items below and confirm acceptance at your earliest convenience.</p>
    ${referenceBlock}
    <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;">
      <thead>
        <tr style="background:#fafaf9;">
          <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #e7e5e4;">Item</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e7e5e4;">Quantity</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e7e5e4;">Unit Price</th>
          <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e7e5e4;">Line Total</th>
        </tr>
      </thead>
      <tbody>${itemRowsHtml || `<tr><td colspan="4" style="padding:14px 12px;color:#78716c;text-align:center;">No line items</td></tr>`}</tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="padding:12px;text-align:right;font-weight:600;border-top:2px solid #1c1917;">Total</td>
          <td style="padding:12px;text-align:right;font-weight:700;border-top:2px solid #1c1917;">${currency} ${formattedTotal}</td>
        </tr>
      </tfoot>
    </table>
    ${safeNotes}
    <p style="margin:24px 0 0;color:#44403c;">Reply to this email if any of the quantities, pricing, or delivery dates need to be revised. Once you confirm, we will proceed with the goods receipt and payment cycle.</p>
    <p style="margin:18px 0 0;color:#78716c;font-size:12px;">This message was generated automatically by EspressGo on PO creation.</p>
  </div>
</div>`;

      const subject = `Purchase Order ${poNumber} from EspressGo`;
      const fromValue = resolveOutreachFromAddress('b2b') || undefined;
      const replyTo = BREVO_REPLY_TO || undefined;
      const transporter = getBrevoTransporter();

      let sentMessageId = null;
      let sentError = null;
      let sandboxed = false;

      if (OUTREACH_SANDBOX_MODE || !transporter) {
        sandboxed = true;
      } else {
        try {
          const htmlDoc = wrapHtmlBody(subject, htmlInner);
          const info = await transporter.sendMail({
            from: fromValue,
            replyTo,
            to: supplierEmail,
            subject,
            html: htmlDoc,
            headers: {
              'X-Espressgo-PO': String(poNumber).slice(0, 200),
            },
          });
          sentMessageId = info?.messageId || null;
        } catch (sendErr) {
          sentError = sendErr?.message || String(sendErr);
          console.error('[/api/supplier/send-po-email] send failed:', sentError);
        }
      }

      // Always log the attempt so operators have an audit trail, and flip the
      // raw_material_orders flags so the supplier PO list shows the right icon.
      try {
        await appendDispatchLogRow({
          campaignId: null,
          recipientEmail: supplierEmail,
          status: sandboxed ? 'sandbox' : (sentError ? 'failed' : 'sent'),
          messageId: sentMessageId,
          error: sentError,
          provider: 'brevo-po',
        });
      } catch (logErr) {
        console.warn('[/api/supplier/send-po-email] dispatch log write failed:', logErr?.message || logErr);
      }

      const delivered = sandboxed || (!sentError && Boolean(sentMessageId));
      const attemptedAt = new Date().toISOString();

      try {
        await updateSql({
          schema: 'public',
          table: 'raw_material_orders',
          data: [{
            email_sent: delivered,
            email_sent_at: delivered ? attemptedAt : null,
            email_error: sentError || null,
            email_recipient: supplierEmail,
          }],
          filters: { eq: { order_number: poNumber } },
        });
      } catch (markErr) {
        console.warn('[/api/supplier/send-po-email] could not mark raw_material_orders.email_sent:', markErr?.message || markErr);
      }

      sendJson(res, 200, {
        ok: delivered,
        sandbox: sandboxed,
        recipient: supplierEmail,
        messageId: sentMessageId,
        error: sentError,
      });
    } catch (err) {
      console.error('[/api/supplier/send-po-email]', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Outreach dispatch: send a campaign to a list of recipients via Brevo ──────
  // Request body:
  //   {
  //     campaignName: string,
  //     campaignType?: 'B2B Corporate' | 'B2C Retail',
  //     targetSegment?: 'b2b' | 'b2c',
  //     subject: string,
  //     bodyHtml: string,             // raw HTML (no escaping needed by client)
  //     recipients: [{ email, client_name?, company_name?, ... }]
  //   }
  //
  // Behavior:
  //   * When OUTREACH_SANDBOX_MODE=true (default), nothing leaves the server.
  //     The endpoint logs each "would-send" entry to outreach_dispatch_log with
  //     status='sandbox' and returns the planned list to the UI.
  //   * When OUTREACH_SANDBOX_MODE=false, each recipient is sent through the
  //     Brevo SMTP relay with a configurable inter-message delay. Errors and
  //     successes are persisted to outreach_dispatch_log.
  //
  // This endpoint intentionally does NOT create the campaign row automatically;
  // the existing UI already saves the campaign via /api/supabase and we just
  // log per-recipient dispatches against the resulting campaign_id.
  if (url.pathname === '/api/outreach/dispatch' && req.method === 'POST') {
    try {
      if (!brevoMailerConfigured && !OUTREACH_SANDBOX_MODE) {
        sendJson(res, 503, {
          ok: false,
          error: 'Brevo SMTP not configured. Set BREVO_SMTP_LOGIN and BREVO_SMTP_KEY in .env, or enable OUTREACH_SANDBOX_MODE=true.',
        });
        return;
      }

      const body = await readJsonBody(req);
      const {
        campaignId = null,
        campaignName = 'Untitled campaign',
        campaignType = null,
        targetSegment = 'b2c',
        subject = '',
        bodyHtml = '',
        recipients: rawRecipients = [],
        attachments: rawAttachments = [],
        suppressIfOnUnsubscribes = true,
      } = body || {};

      if (!subject || typeof subject !== 'string') {
        sendJson(res, 400, { ok: false, error: 'subject is required' });
        return;
      }
      if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
        sendJson(res, 400, { ok: false, error: 'recipients must be a non-empty array' });
        return;
      }

      // Normalize + cap recipients.
      const normalized = rawRecipients
        .filter((r) => r && typeof r === 'object' && typeof r.email === 'string' && r.email.includes('@'))
        .map((r) => ({ ...r, email: String(r.email).trim().toLowerCase() }));

      const deduped = [];
      const seen = new Set();
      for (const r of normalized) {
        if (seen.has(r.email)) continue;
        seen.add(r.email);
        deduped.push(r);
      }

      if (deduped.length > OUTREACH_MAX_RECIPIENTS_PER_RUN) {
        sendJson(res, 400, {
          ok: false,
          error: `Recipient count ${deduped.length} exceeds OUTREACH_MAX_RECIPIENTS_PER_RUN=${OUTREACH_MAX_RECIPIENTS_PER_RUN}`,
        });
        return;
      }

      // Resolve attachments once before the per-recipient loop. Each entry is
      // { publicUrl, fileName } as produced by /api/uploads. We:
      //   - skip non-array / empty input silently (attachments are optional)
      //   - refuse anything that doesn't resolve inside ./uploads/outreach/
      //   - read the bytes off disk now so a missing/moved file aborts the
      //     whole dispatch (better than half a campaign going out without a PDF)
      const attachments = [];
      if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
        const uploadsRootWithSep = uploadsRoot + path.sep;
        for (let i = 0; i < rawAttachments.length; i += 1) {
          const entry = rawAttachments[i];
          if (!entry || typeof entry !== 'object') continue;
          const rawUrl = typeof entry.publicUrl === 'string' ? entry.publicUrl : '';
          if (!rawUrl) continue;
          // Strip the leading "/" and convert URL separators to OS-native.
          const stripped = rawUrl.replace(/^\/+/, '').replace(/\//g, path.sep);
          // Accept any file that lives anywhere under the uploads root. The
          // upload handler already restricts categories to UPLOAD_ALLOWED_CATEGORIES
          // (documents, purchase-records, receipts, outreach, support, avatars,
          // misc) and rejects anything else, so re-validating the category here
          // would only block legitimate sends from other pages that share this
          // upload pipeline. The path-escape check below is the real security
          // boundary — we never want a `../` slipping through.
          if (!stripped.startsWith(`${UPLOAD_DIR_NAME}${path.sep}`)) {
            sendJson(res, 400, {
              ok: false,
              error: `attachment[${i}] must be inside /${UPLOAD_DIR_NAME}/ (got: ${rawUrl})`,
            });
            return;
          }
          const absPath = path.join(rootDir, stripped);
          if (!absPath.startsWith(uploadsRootWithSep)) {
            sendJson(res, 400, { ok: false, error: `attachment[${i}] path escape rejected` });
            return;
          }
          try {
            const fileStat = await stat(absPath);
            if (!fileStat.isFile()) {
              sendJson(res, 400, { ok: false, error: `attachment[${i}] is not a regular file` });
              return;
            }
            // 10MB cap matches the upload route's own ceiling; Brevo's SMTP API
            // rejects much larger attachments anyway.
            if (fileStat.size > 10 * 1024 * 1024) {
              sendJson(res, 400, { ok: false, error: `attachment[${i}] exceeds 10MB` });
              return;
            }
            const content = await readFile(absPath);
            const safeName = String(entry.fileName || path.basename(absPath)).replace(/[\r\n"]/g, '_').slice(0, 200);
            attachments.push({ filename: safeName, content });
          } catch (fileErr) {
            sendJson(res, 400, {
              ok: false,
              error: `attachment[${i}] could not be read: ${fileErr?.message || String(fileErr)}`,
            });
            return;
          }
        }
      }

      // Filter out addresses on the suppression list (only when sandbox is OFF,
      // so the operator can still see what *would* be skipped in test mode).
      let recipients = deduped;
      let skippedUnsubscribed = 0;
      if (suppressIfOnUnsubscribes && !OUTREACH_SANDBOX_MODE) {
        try {
          const unsubRows = await selectSql({
            schema: 'public',
            table: 'outreach_unsubscribes',
            columns: 'email',
          });
          const unsubSet = new Set(
            (Array.isArray(unsubRows) ? unsubRows : [])
              .map((row) => String(row.email || '').trim().toLowerCase())
              .filter(Boolean)
          );
          recipients = deduped.filter((r) => !unsubSet.has(r.email));
          skippedUnsubscribed = deduped.length - recipients.length;
        } catch (e) {
          // If the unsubscribes table doesn't exist yet, don't block dispatch.
          console.warn('[outreach] suppression check failed (table missing?):', e?.message || e);
        }
      }

      const fromValue = resolveOutreachFromAddress(targetSegment);
      const replyTo = BREVO_REPLY_TO || undefined;
      const transporter = getBrevoTransporter();

      const results = [];
      for (let i = 0; i < recipients.length; i += 1) {
        const recipient = recipients[i];
        const renderedSubject = renderOutreachTemplate(subject, recipient);
        const renderedBody = renderOutreachTemplate(bodyHtml || '', recipient);
        const htmlDoc = wrapHtmlBody(renderedSubject, renderedBody);

        if (OUTREACH_SANDBOX_MODE) {
          await appendDispatchLogRow({
            campaignId,
            recipientEmail: recipient.email,
            status: 'sandbox',
            error: null,
          });
          results.push({
            email: recipient.email,
            status: 'sandbox',
            messageId: null,
          });
          continue;
        }

        try {
          const info = await transporter.sendMail({
            from: fromValue || undefined,
            replyTo,
            to: recipient.email,
            subject: renderedSubject,
            html: htmlDoc,
            attachments,
            // Brevo wraps these into the message headers; harmless when blank.
            headers: {
              'X-Outreach-Campaign': String(campaignName).slice(0, 200),
            },
          });
          const messageId = info?.messageId || null;
          await appendDispatchLogRow({
            campaignId,
            recipientEmail: recipient.email,
            status: 'sent',
            messageId,
          });
          results.push({ email: recipient.email, status: 'sent', messageId });
        } catch (sendErr) {
          const errorMessage = sendErr?.message || String(sendErr);
          await appendDispatchLogRow({
            campaignId,
            recipientEmail: recipient.email,
            status: 'failed',
            error: errorMessage,
          });
          results.push({ email: recipient.email, status: 'failed', error: errorMessage });
        }

        // Inter-message delay keeps us well below the Brevo free-tier rate limits
        // and avoids tripping spam filters on small sending IPs.
        if (OUTREACH_DELAY_BETWEEN_MS > 0 && i < recipients.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, OUTREACH_DELAY_BETWEEN_MS));
        }
      }

      sendJson(res, 200, {
        ok: true,
        sandbox: OUTREACH_SANDBOX_MODE,
        campaignId,
        total: recipients.length,
        skippedUnsubscribed,
        sent: results.filter((r) => r.status === 'sent').length,
        sandboxed: results.filter((r) => r.status === 'sandbox').length,
        failed: results.filter((r) => r.status === 'failed').length,
        attachmentCount: attachments.length,
        results,
      });
    } catch (err) {
      console.error('[/api/outreach/dispatch]', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Create unique constraint on chat_channels.order_id ─────────────────────────
  // Partial indexes can't be used in ON CONFLICT — need full unique constraint
  if (url.pathname === '/api/setup-channel-constraint' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      // 1. Drop the partial index
      await runManagementSql(`DROP INDEX IF EXISTS public.idx_chat_channels_order_id`);
      // 2. Create full unique index on order_id (allows NULLs but NULL != NULL so duplicates only for non-null)
      const result = await runManagementSql(
        `CREATE UNIQUE INDEX idx_chat_channels_order_id ON public.chat_channels (order_id)`
      );
      sendJson(res, 200, { data: result, error: null });
    } catch (err) {
      sendJson(res, 500, { data: null, error: err.message });
    }
    return;
  }

  // ── Create chat_ai_log table for AI auto-reply audit trail ──────────────────
  // Stores every AI-generated reply: the prompt, the response, the customer
  // message that triggered it, and the gate decision (sent / skipped / hand-off).
  // RLS is intentionally disabled per project policy.
  if (url.pathname === '/api/setup-ai-log' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      await runManagementSql(`
        CREATE TABLE IF NOT EXISTS public.chat_ai_log (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at timestamptz NOT NULL DEFAULT now(),
          channel_id uuid,
          order_id text,
          customer_message_id uuid,
          customer_message_text text,
          model text,
          prompt_text text,
          reply_text text,
          gate_decision text,
          gate_reason text,
          metadata jsonb
        );
      `);
      await runManagementSql(`
        ALTER TABLE public.chat_ai_log DISABLE ROW LEVEL SECURITY;
      `);
      await runManagementSql(`
        CREATE INDEX IF NOT EXISTS idx_chat_ai_log_channel
          ON public.chat_ai_log (channel_id, created_at DESC);
      `);
      // chat_messages gets two new columns used by the AI reply flow:
      //   is_ai        — marks the row as an AI-generated staff reply
      //   ai_reply_to  — the customer message id this AI reply responds to (idempotency)
      await runManagementSql(`
        ALTER TABLE public.chat_messages
          ADD COLUMN IF NOT EXISTS is_ai boolean NOT NULL DEFAULT false;
      `);
      await runManagementSql(`
        ALTER TABLE public.chat_messages
          ADD COLUMN IF NOT EXISTS ai_reply_to uuid;
      `);
      await runManagementSql(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_is_ai
          ON public.chat_messages (is_ai, ai_reply_to);
      `);
      sendJson(res, 200, { data: 'ok', error: null });
    } catch (err) {
      sendJson(res, 500, { data: null, error: err.message });
    }
    return;
  }

  // ── Enable Supabase Realtime on chat tables ───────────────────────────────────
  // Uses Supabase Management API to add tables to supabase_realtime publication
  if (url.pathname === '/api/enable-realtime' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const tables = ['chat_messages', 'chat_channels', 'chat_participants'];
      const results = [];
      for (const table of tables) {
        // Add table to supabase_realtime publication
        const resp = await runManagementSql(
          `ALTER PUBLICATION supabase_realtime ADD TABLE public.${table}`
        );
        results.push({ table, result: resp });
      }
      sendJson(res, 200, { data: results, error: null });
    } catch (err) {
      // Ignore errors if realtime is already enabled
      sendJson(res, 200, { data: null, error: err.message.includes('already') ? null : err.message });
    }
    return;
  }

  // ── Cleanup endpoint: merge duplicate channels, keep latest, delete others ──
  if (url.pathname === '/api/cleanup-channels' && req.method === 'POST') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      const result = await runManagementSql(`
        WITH ranked AS (
          SELECT id, order_id, created_at,
            ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY created_at DESC) as rn
          FROM public.chat_channels
          WHERE order_id IS NOT NULL
        ),
        to_delete AS (
          SELECT id, order_id FROM ranked WHERE rn > 1
        ),
        kept AS (
          SELECT id, order_id FROM ranked WHERE rn = 1
        ),
        messages_moved AS (
          UPDATE public.chat_messages cm
          SET channel_id = (
            SELECT k.id FROM kept k
            JOIN to_delete td ON td.order_id = k.order_id
            WHERE td.id = cm.channel_id
            LIMIT 1
          )
          WHERE cm.channel_id IN (SELECT id FROM to_delete)
          RETURNING id
        )
        DELETE FROM public.chat_channels WHERE id IN (SELECT id FROM to_delete)
        RETURNING id, order_id;
      `);
      sendJson(res, 200, { data: result, error: null });
    } catch (err) {
      sendJson(res, 500, { data: null, error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/realtime-status' && req.method === 'GET') {
    try {
      if (!sqlProxyConfigured) {
        sendJson(res, 500, { error: 'SQL proxy not configured' });
        return;
      }
      // Check Supabase realtime management API
      const realtimeResp = await fetch(
        `https://api.supabase.com/v1/projects/${supabaseProjectRef}/realtime`,
        { headers: { Authorization: `Bearer ${supabaseManagementToken}` } }
      );
      const realtimeData = await realtimeResp.json().catch(() => ({}));
      
      // Check publication status
      const pubRows = await runManagementSql(
        `SELECT pubname, schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public'`
      );

      sendJson(res, 200, {
        realtimeHttpStatus: realtimeResp.status,
        realtimeData,
        publicationTables: pubRows
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/auth/create-user' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { email, password, name } = body;

      if (!email || !password) {
        sendJson(res, 400, { error: 'Email and password are required' });
        return;
      }

      if (!supabaseAdmin) {
        sendJson(res, 500, { error: 'Supabase admin not configured' });
        return;
      }

      // Create auth user via Supabase Admin API
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: name || email.split('@')[0] }
      });

      if (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }

      sendJson(res, 200, { user: data.user, session: data.session });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // ── Local uploads (POST/DELETE /api/uploads) ────────────────────────────────
  // All file storage is now local disk (./uploads/<category>/<date>/<file>).
  // No Supabase Storage dependency. Public URLs are served back as
  // /uploads/<category>/<date>/<file> and resolved via handleStatic's
  // uploads-root sandbox check.
  if (url.pathname === '/api/uploads' && req.method === 'POST') {
    await handleUpload(req, res);
    return;
  }

  // DELETE is the only verb accepted for removal; the previous POST alias
  // was unused by any caller and made the contract ambiguous.
  if (url.pathname === '/api/uploads' && req.method === 'DELETE') {
    await handleUploadDelete(req, res);
    return;
  }

  // ── Payroll Finalize Endpoint ─────────────────────────────────────────────
  if (url.pathname === '/api/payroll/finalize' && req.method === 'POST') {
    const session = readStaffSessionFromRequest(req);
    if (!session) { sendJson(res, 401, { error: 'Not authenticated' }); return; }
    try {
      const body = await readJsonBody(req);
      const { cycle } = body;
      if (!cycle) { sendJson(res, 400, { error: 'cycle is required' }); return; }
      
      const stage = await getCycleStage(cycle);
      if (stage !== 'Locked' && stage !== 'Paid') {
        sendJson(res, 400, { error: 'Cannot finalize: adjustment period is still active or not yet pay day' });
        return;
      }

      const runCheckSql = `SELECT id FROM public.payroll_runs WHERE cycle = ${sqlValue(cycle, 'cycle')} LIMIT 1`;
      const runCheckRows = parseSqlRows(await runManagementSql(runCheckSql));
      if (runCheckRows && runCheckRows.length > 0) {
        sendJson(res, 400, { error: 'Payroll cycle already finalized' });
        return;
      }

      await runManagementSql(`SELECT public.finalize_payroll_cycle(${sqlValue(cycle, 'target_cycle')}, ${sqlValue(session.email || 'operator', 'operator_email')})`);
      
      sendJson(res, 200, { ok: true, cycle });
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
    return;
  }

  // ── Payroll Diagnostic Endpoint ──────────────────────────────────────────────
  if (url.pathname === '/api/payroll/diagnostic' && req.method === 'GET') {
    const session = readStaffSessionFromRequest(req);
    if (!session) { sendJson(res, 401, { error: 'Not authenticated' }); return; }
    try {
      const settings = await getCompanySettings();
      const now = new Date();
      const result = {
        timestamp: now.toISOString(),
        serverTime: {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          day: now.getDate(),
          hour: now.getHours(),
          minute: now.getMinutes(),
        },
        supabaseConfigured: !!supabaseAdmin,
        sqlProxyConfigured,
        settings,
        salaryCycles: [],
        payrollRuns: [],
        cyclesReadyForFinalization: [],
        cycleStages: {},
      };

      const salarySql = `SELECT DISTINCT cycle, payment_status FROM public.salaries WHERE cycle IS NOT NULL ORDER BY cycle`;
      const salaryRows = parseSqlRows(await runManagementSql(salarySql));
      result.salaryCycles = salaryRows || [];

      const runsSql = `SELECT * FROM public.payroll_runs ORDER BY created_at DESC LIMIT 12`;
      const runRows = parseSqlRows(await runManagementSql(runsSql));
      result.payrollRuns = runRows || [];

      for (const row of (salaryRows || [])) {
        const stage = await getCycleStage(row.cycle);
        result.cycleStages[row.cycle] = {
          stage,
          payment_status: row.payment_status,
          payroll_run_exists: (runRows || []).some(r => r.cycle === row.cycle),
        };
        if ((stage === 'Locked' || stage === 'Paid') && !(runRows || []).some(r => r.cycle === row.cycle)) {
          result.cyclesReadyForFinalization.push(row.cycle);
        }
      }

      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
    return;
  }

  // ── Payroll Auto-Process Endpoint (Manual Trigger) ─────────────────────────
  if (url.pathname === '/api/payroll/auto-process' && req.method === 'POST') {
    const session = readStaffSessionFromRequest(req);
    if (!session) { sendJson(res, 401, { error: 'Not authenticated' }); return; }
    try {
      const body = await readJsonBody(req);
      const { cycle } = body;

      const sql = cycle
        ? `SELECT DISTINCT cycle FROM public.salaries WHERE payment_status <> 'Paid' AND cycle = ${sqlValue(cycle, 'cycle')} AND cycle IS NOT NULL`
        : `SELECT DISTINCT cycle FROM public.salaries WHERE payment_status <> 'Paid' AND cycle IS NOT NULL`;
      const rows = parseSqlRows(await runManagementSql(sql));
      const uniqueCycles = (rows || []).map(r => r.cycle);

      const processed = [];
      const errors = [];

      for (const c of uniqueCycles) {
        const stage = await getCycleStage(c);
        if (stage === 'Locked' || stage === 'Paid') {
          const runCheckSql = `SELECT id FROM public.payroll_runs WHERE cycle = ${sqlValue(c, 'cycle')} LIMIT 1`;
          const runCheckRows = parseSqlRows(await runManagementSql(runCheckSql));
          if (!runCheckRows || runCheckRows.length === 0) {
            await runManagementSql(`SELECT public.finalize_payroll_cycle(${sqlValue(c, 'target_cycle')}, ${sqlValue(session.email || 'operator', 'operator_email')})`);
            processed.push(c);
          }
        } else {
          errors.push({ cycle: c, reason: `Cycle is in "${stage}" stage, not yet ready for auto-processing` });
        }
      }

      sendJson(res, 200, { ok: true, processed, skipped: errors });
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
    return;
  }

  // ── Customer session endpoints ────────────────────────────────────────────
  // These four routes are the only place the customer portal session is
  // established. The browser cannot reach inside the httpOnly cookie, so the
  // portal goes through here for login / register / logout / "who am I".
  if (url.pathname === '/api/session/login' && req.method === 'POST') {
    await handleSessionLogin(req, res);
    return;
  }
  if (url.pathname === '/api/session/register' && req.method === 'POST') {
    await handleSessionRegister(req, res);
    return;
  }
  if (url.pathname === '/api/session/logout' && (req.method === 'POST' || req.method === 'DELETE')) {
    await handleSessionLogout(req, res);
    return;
  }
  if (url.pathname === '/api/session/me' && req.method === 'GET') {
    await handleSessionMe(req, res);
    return;
  }
  if (url.pathname === '/api/staff-session/login' && req.method === 'POST') {
    await handleStaffSessionLogin(req, res);
    return;
  }
  if (url.pathname === '/api/staff-session/me' && req.method === 'GET') {
    await handleStaffSessionMe(req, res);
    return;
  }
  if (url.pathname === '/api/staff-session/logout' && (req.method === 'POST' || req.method === 'DELETE')) {
    await handleStaffSessionLogout(req, res);
    return;
  }

  if (serveStatic && (req.method === 'GET' || req.method === 'HEAD')) {
    await handleStatic(req, res);
    return;
  }

  const statusCode = url.pathname.startsWith('/api/') ? 405 : 404;
  sendJson(res, statusCode, { error: statusCode === 405 ? 'Method not allowed' : 'Not found' });
}

// ── /api/session/* handlers ──────────────────────────────────────────────────

function publicSessionFromClaims(claims) {
  if (!claims) return null;
  // Never expose the full JWT or refresh tokens back to the browser — the
  // portal only needs identity + segment to render.
  return {
    email: claims.email || null,
    name: claims.name || null,
    company: claims.company || '',
    segment: claims.segment || null,
    role: claims.role || 'client',
    userId: claims.sub || null,
    phone: claims.phone || '',
    address: claims.address || '',
    expiresAt: claims.exp ? claims.exp * 1000 : null,
  };
}

// ── /api/staff-session/* handlers ─────────────────────────────────────────────

async function handleStaffSessionLogin(req, res) {
  if (!SESSION_COOKIE_SECRET) {
    sendJson(res, 503, { error: 'Session signing secret not configured on the server.' });
    return;
  }
  if (!supabaseAdmin) {
    // Same posture as the customer portal: no real auth provider means no
    // session can be issued — a "trust the body" fallback would let any
    // caller log in as any email.
    sendJson(res, 503, { error: 'Authentication service is not configured on the server.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) {
    sendJson(res, 400, { error: 'Email and password are required.' });
    return;
  }

  // Verify the password via Supabase Auth. Same intent as the customer flow:
  // the canonical source of truth for the password grant is Supabase. We do
  // NOT call /auth/v1/admin/createUser or generate_link here — that has side
  // effects we don't want during a login attempt.
  let supabaseUser = null;
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.access_token) {
      const msg = data?.error_description || data?.msg || data?.message || 'Invalid email or password.';
      sendJson(res, 401, { error: msg });
      return;
    }
    // Use the issued JWT to load the canonical user record.
    try {
      const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${data.access_token}`,
        },
      });
      if (userResp.ok) supabaseUser = await userResp.json();
    } catch { /* fall through — email is still trusted below */ }
    if (!supabaseUser) {
      supabaseUser = { id: null, email };
    }
  } catch (err) {
    sendJson(res, 502, { error: 'Auth service unavailable: ' + (err.message || err) });
    return;
  }

  // Fail closed: a valid Supabase login is necessary but not sufficient. The
  // caller must also have a row in public.staff_profiles with an allowed role.
  const profile = await loadStaffProfile(supabaseUser.email || email);
  if (!profile) {
    // Intentionally vague — don't leak whether the email exists.
    sendJson(res, 403, {
      error: 'No staff profile is associated with this account. Ask an admin to provision your account.',
    });
    return;
  }

  const jwt = signSessionJwt({
    sub: supabaseUser.id || null,
    email: supabaseUser.email || email,
    role: profile.role,
    department: profile.department,
    staff_id: profile.staff_id,
    segment: 'staff',
  });
  setSessionCookie(req, res, jwt, { name: STAFF_COOKIE_NAME });
  sendJson(res, 200, {
    ok: true,
    session: {
      email: supabaseUser.email || email,
      role: profile.role,
      department: profile.department,
      staff_id: profile.staff_id,
      userId: supabaseUser.id || null,
    },
  });
}

async function handleStaffSessionMe(req, res) {
  const session = readStaffSessionFromRequest(req);
  if (!session) {
    sendJson(res, 200, { session: null });
    return;
  }
  sendJson(res, 200, {
    session: {
      email: session.email,
      role: session.role,
      department: session.department || '',
      staff_id: session.staff_id || null,
      userId: session.sub || null,
    },
  });
}

async function handleStaffSessionLogout(req, res) {
  clearSessionCookie(req, res, { name: STAFF_COOKIE_NAME });
  sendJson(res, 200, { ok: true });
}

async function handleSessionLogin(req, res, _preparsedBody = null) {
  if (!SESSION_COOKIE_SECRET) {
    sendJson(res, 503, { error: 'Session signing secret not configured on the server.' });
    return;
  }
  let body;
  try {
    body = _preparsedBody !== null ? _preparsedBody : await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const segment = String(body.segment || '').trim();
  if (!email || !password) {
    sendJson(res, 400, { error: 'Email and password are required.' });
    return;
  }
  if (segment && segment !== 'b2b' && segment !== 'b2c') {
    sendJson(res, 400, { error: 'segment must be "b2c" or "b2b".' });
    return;
  }

  let supabaseUser = null;
  let supabaseSession = null;

  // Always try real Supabase Auth first when we have an admin client — that's
  // the canonical source of truth for the user's email/password. The "local
  // ERP" mode (no Supabase Auth configured) is only for offline/dev use.
  if (supabaseAdmin) {
    // Hit the password grant directly. It returns 400 "Invalid login
    // credentials" for unknown users AND wrong passwords — Supabase
    // intentionally collapses the two cases to prevent email enumeration,
    // which is fine for us. Crucially this endpoint has NO side effects,
    // unlike `admin/generate_link` which would create an account if we used
    // it as a probe.
    try {
      const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.access_token) {
        const msg = data?.error_description || data?.msg || data?.message || 'Invalid email or password.';
        sendJson(res, 401, { error: msg });
        return;
      }
      supabaseSession = data;
      // Verify and load the full user record via /user (uses the issued JWT).
      try {
        const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${data.access_token}`,
          },
        });
        if (userResp.ok) supabaseUser = await userResp.json();
      } catch {
        // ignore — we still have email from the request body
      }
      if (!supabaseUser) {
        // Fall back to a denormalised session — email/name/company default
        // to what the caller sent.
        supabaseUser = { id: null, email, user_metadata: {} };
      }
    } catch (err) {
      sendJson(res, 502, { error: 'Auth service unavailable: ' + (err.message || err) });
      return;
    }
  } else {
    // No Supabase configured. Never issue a signed session without verifying
    // the password — that would let any caller forge a login for any email.
    sendJson(res, 503, { error: 'Authentication service is not configured on the server.' });
    return;
  }

  const metadata = supabaseUser?.user_metadata || {};
  const claimSegment = metadata.segment || segment || 'b2c';
  if (claimSegment !== 'b2c' && claimSegment !== 'b2b') {
    sendJson(res, 400, { error: 'Account segment is not a customer segment.' });
    return;
  }
  if (segment && segment !== claimSegment) {
    sendJson(res, 403, {
      error: `This account belongs to the ${claimSegment.toUpperCase()} portal. Please use the ${claimSegment.toUpperCase()} page instead.`,
    });
    return;
  }

  // Best-effort fetch of the customer_accounts row so the cookie carries the
  // display name / company even when the JWT metadata is empty.
  let profileRow = null;
  if (supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin
        .schema('public')
        .from(claimSegment === 'b2b' ? 'customer_accounts' : 'retail_buyers')
        .select('email, name, company_name, phone, address, verification_status')
        .eq('email', email)
        .limit(1);
      if (Array.isArray(data) && data.length > 0) profileRow = data[0];
    } catch {
      // optional — non-fatal
    }
  }

  const jwt = signSessionJwt({
    sub: supabaseUser.id || null,
    email,
    name: profileRow?.name || metadata.name || email.split('@')[0],
    company: profileRow?.company_name || metadata.company_name || '',
    segment: claimSegment,
    role: 'client',
  });

  setSessionCookie(req, res, jwt);
  sendJson(res, 200, {
    session: publicSessionFromClaims(verifySessionJwt(jwt)),
  });
}

async function handleSessionRegister(req, res, _preparsedBody = null) {
  if (!SESSION_COOKIE_SECRET) {
    sendJson(res, 503, { error: 'Session signing secret not configured on the server.' });
    return;
  }
  let body;
  try {
    body = _preparsedBody !== null ? _preparsedBody : await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const company = String(body.company || '').trim();
  const segment = String(body.segment || 'b2c').trim();
  const phone = body.phone ? String(body.phone).trim() : null;
  const address = body.address ? String(body.address).trim() : null;

  if (!email || !password || !name) {
    sendJson(res, 400, { error: 'name, email and password are required.' });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    return;
  }
  if (segment !== 'b2b' && segment !== 'b2c') {
    sendJson(res, 400, { error: 'segment must be "b2c" or "b2b".' });
    return;
  }

  let supabaseUser = null;

  if (supabaseAdmin) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name,
        company_name: company || '',
        segment,
        phone: phone || null,
        address: address || null,
      },
    });
    if (error) {
      const lower = (error.message || '').toLowerCase();
      if (lower.includes('already') || lower.includes('exists')) {
        // If the account already exists, fall through to a "log in" flow so
        // returning users don't get stuck on the onboarding screen.
        // Pass the parsed body so login doesn't try to re-read the (already
        // consumed) HTTP request stream.
        return handleSessionLogin(req, res, body);
      }
      sendJson(res, 400, { error: error.message });
      return;
    }
    supabaseUser = data.user;
  } else {
    // No Supabase configured. Never issue a signed session without going
    // through the real auth provider — that would let any caller create an
    // account for any email and immediately receive a session cookie.
    sendJson(res, 503, { error: 'Authentication service is not configured on the server.' });
    return;
  }

  // Persist into customer_accounts (b2b) or retail_buyers (b2c) so the
  // portal can read the verification_status and display profile fields
  // without re-querying auth.
  // Note: route through the SQL proxy helpers (selectSql/insertSqlRows/
  // updateSql) instead of supabaseAdmin.from() directly — the REST admin
  // path was throwing "permission denied for table retail_buyers" because
  // the service-role JWT used by supabaseAdmin lacks table grants on
  // retail_buyers. The SQL proxy uses a management token with full DML.
  if (sqlProxyConfigured && !sqlProxyDisabled) {
    try {
      const table = segment === 'b2b' ? 'customer_accounts' : 'retail_buyers';
      const existing = await selectSql({
        schema: 'public',
        table,
        columns: 'id',
        filters: { eq: { email } },
        data: { limit: 1 },
      });

      if (existing && existing.length > 0) {
        const updateData = segment === 'b2b'
          ? {
              name,
              company_name: company || null,
              segment,
              is_active: true,
              phone: phone || null,
              address: address || null,
            }
          : { name, segment, is_active: true, phone: phone || null, address: address || null };
        await updateSql({
          schema: 'public',
          table,
          data: updateData,
          filters: { eq: { email } },
        });
      } else {
        const insertRow = segment === 'b2b'
          ? {
              email,
              name,
              company_name: company || null,
              segment,
              is_active: true,
              verification_status: 'pending',
              phone: phone || null,
              address: address || null,
            }
          : { email, name, segment, is_active: true, phone: phone || null, address: address || null };
        await insertSqlRows({
          schema: 'public',
          table,
          data: insertRow,
        });
      }
    } catch (err) {
      console.warn('[session/register] could not persist customer profile:', err.message || err);
    }
  } else if (supabaseAdmin) {
    // Fallback when SQL proxy isn't configured.
    try {
      const table = segment === 'b2b' ? 'customer_accounts' : 'retail_buyers';
      const row = segment === 'b2b'
        ? {
            email,
            name,
            company_name: company || null,
            segment,
            is_active: true,
            verification_status: 'pending',
            phone: phone || null,
            address: address || null,
          }
        : { email, name, segment, is_active: true, phone: phone || null, address: address || null };
      const { data: existing } = await supabaseAdmin
        .schema('public')
        .from(table)
        .select('id')
        .eq('email', email)
        .limit(1);
      if (existing && existing.length > 0) {
        await supabaseAdmin.schema('public').from(table).update(row).eq('email', email);
      } else {
        await supabaseAdmin.schema('public').from(table).insert(row);
      }
    } catch (err) {
      console.warn('[session/register] could not persist customer profile:', err.message || err);
    }
  }

  const jwt = signSessionJwt({
    sub: supabaseUser.id || null,
    email,
    name,
    company: company || '',
    segment,
    phone: phone || '',
    address: address || '',
    role: 'client',
  });

  setSessionCookie(req, res, jwt);
  sendJson(res, 200, {
    session: publicSessionFromClaims(verifySessionJwt(jwt)),
  });
}

async function handleSessionLogout(req, res) {
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}

async function handleSessionMe(req, res) {
  const session = readSessionFromRequest(req);
  if (!session) {
    sendJson(res, 200, { session: null });
    return;
  }
  sendJson(res, 200, { session: publicSessionFromClaims(session) });
}

async function runAutoPayrollCron() {
  console.log('[payroll-cron] Initializing — supabaseAdmin:', !!supabaseAdmin, '| sqlProxyConfigured:', sqlProxyConfigured);

  const checkAndRun = async () => {
    try {
      const settings = await getCompanySettings();
      const now = new Date();
      console.log(`[payroll-cron] Checking payroll at ${now.toISOString()}...`);

      let salaryCycles = [];
      try {
        const sql = `SELECT DISTINCT cycle, payment_status FROM public.salaries WHERE cycle IS NOT NULL ORDER BY cycle`;
        const rows = parseSqlRows(await runManagementSql(sql));
        salaryCycles = (rows || []).map(r => r.cycle);
        console.log(`[payroll-cron] Found salary cycles:`, salaryCycles);
      } catch (sqlErr) {
        console.error('[payroll-cron] Failed to query salary cycles (Management API):', sqlErr.message);
        console.warn('[payroll-cron] Falling back to supabaseAdmin REST API for salary cycles...');
        try {
          const { data: fallbackRows } = await supabaseAdmin.from('salaries').select('cycle').not('cycle', 'is', null).not('payment_status', 'eq', 'Paid');
          const seen = new Set();
          salaryCycles = (fallbackRows || []).filter(r => { if (seen.has(r.cycle)) return false; seen.add(r.cycle); return true; }).map(r => r.cycle);
          console.log(`[payroll-cron] Fallback found cycles:`, salaryCycles);
        } catch (fallbackErr) {
          console.error('[payroll-cron] Fallback also failed:', fallbackErr.message);
          return;
        }
      }

      if (salaryCycles.length === 0) {
        console.log('[payroll-cron] No unpaid salary cycles found — nothing to do.');
        return;
      }

      for (const cycle of salaryCycles) {
        const stage = await getCycleStage(cycle);
        console.log(`[payroll-cron] Cycle "${cycle}" → stage: "${stage}"`);
        if (stage === 'Locked' || stage === 'Paid') {
          try {
            const runCheckSql = `SELECT id FROM public.payroll_runs WHERE cycle = ${sqlValue(cycle, 'cycle')} LIMIT 1`;
            const runCheckRows = parseSqlRows(await runManagementSql(runCheckSql));
            if (runCheckRows && runCheckRows.length > 0) {
              console.log(`[payroll-cron] Cycle "${cycle}" already finalized — skipping.`);
              continue;
            }
          } catch (runCheckErr) {
            console.error(`[payroll-cron] Failed to check payroll_runs for "${cycle}":`, runCheckErr.message);
          }

          try {
            await runManagementSql(`SELECT public.finalize_payroll_cycle(${sqlValue(cycle, 'target_cycle')}, 'system-auto-cron')`);
            console.log(`[payroll-cron] ✓ Auto-processed payroll cycle: ${cycle}`);
          } catch (finalizeErr) {
            console.error(`[payroll-cron] Failed to finalize cycle "${cycle}":`, finalizeErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[payroll-cron] Error in background job:', err.message || err);
    }
  };

  checkAndRun().catch(err => console.error('[payroll-cron] Boot execution failed:', err));

  setInterval(() => {
    checkAndRun().catch(err => console.error('[payroll-cron] Interval execution failed:', err));
  }, 60000);
}

export function startServer() {
  const server = createServer(handleRequest);

  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.log(`ERP server is already running at http://localhost:${port}`);
      console.log(`Use that existing server, or start another copy with a different port: $env:PORT=3001; node server.js`);
      process.exit(0);
    }

    throw error;
  });

  server.listen(port, () => {
    console.log(`ERP app running at http://localhost:${port}`);
    console.log(`Supabase REST fallback: ${supabaseAdmin ? 'configured' : 'missing .env credentials'}`);
    console.log(`Supabase SQL proxy: ${sqlProxyConfigured ? 'configured' : 'missing management token'}`);
    console.log(`Cookie Secure flag (bind-time fallback): ${SESSION_COOKIE_SECURE ? 'on (HTTPS required)' : 'off (private network host detected)'}${SESSION_COOKIE_SECURE_EXPLICIT === null ? ` [host=${SESSION_COOKIE_DETECTED_HOST}]` : ' [from SESSION_COOKIE_SECURE env]'}`);
    console.log(`Cookie Secure flag (per-request): recomputed from req.headers.host (X-Forwarded-Host if TRUST_PROXY=1); private-network hosts skip Secure.`);

    // Self-heal existing orphan FG allocations at boot. Idempotent — leaves
    // rows alone if their source order is live, releases them if the
    // source order has been deleted (typically by a previous failed
    // checkout that did not free its allocations). Without this sweep,
    // orphaned reservations persist indefinitely and block future
    // checkouts of the same product.
    sweepOrphanFGAllocations().catch((err) => {
      console.warn('[FIFO FG] Orphan sweep failed at boot:', err?.message || err);
    });
    runAutoPayrollCron();
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}

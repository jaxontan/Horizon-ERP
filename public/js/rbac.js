/**
 * EsspressGO RBAC — Role-Based Access Control
 *
 * Load this after erp-supabase.js so localStorage is populated.
 * All page scripts and the sidebar import this for permission checks.
 *
 * Usage:
 *   import { can, must, guardPage } from '/public/js/rbac.js';
 *   if (can('staff:write'))    { renderCreateButton(); }
 *   if (can('salary:read'))    { renderSalarySection(); }
 *   guardPage('salary:write'); // redirects if not allowed
 */

// ─── Permission Matrix ─────────────────────────────────────────────────────────
// Format: MODULE:ACTION
// Actions: read | write | delete | admin (full CRUD)
// Roles map to the `user-role` stored in localStorage on login.
//
// NOTE: this map is wider than the server's SERVER_PERMISSIONS in server.js —
// it adds :delete and :admin variants for fine-grained UI hiding. The server
// only enforces :read/:write. Unknown permission keys (anything not in the
// server's matrix) return false from can() and from /api/rbac/effective, so
// they self-disable until you add the corresponding server key.

const PERMISSIONS = {
    // ── Staff Management ──────────────────────────────────────────────────────
    'staff:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'staff:write':   ['admin'],
    'staff:delete':  ['admin'],
    'staff:admin':   ['admin'],

    // ── Salaries ─────────────────────────────────────────────────────────────
    'salary:read':   ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'salary:write':  ['admin'],
    'salary:delete': ['admin'],
    'salary:admin':  ['admin'],

    // ── Warehouse Inventory ───────────────────────────────────────────────────
    'inventory:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'inventory:write':   ['admin', 'procurement', 'production'],
    'inventory:delete':  ['admin'],
    'inventory:admin':   ['admin'],

    // ── Raw Materials ────────────────────────────────────────────────────────
    'raw_materials:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'raw_materials:write':   ['admin', 'procurement'],
    'raw_materials:delete':  ['admin'],
    'raw_materials:admin':   ['admin'],

    // ── Production Recipes ────────────────────────────────────────────────────
    'recipes:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'recipes:write':   ['admin', 'production'],
    'recipes:delete':  ['admin'],
    'recipes:admin':   ['admin'],

    // ── Production Pipeline ───────────────────────────────────────────────────
    'production:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'production:write':   ['admin', 'production'],
    'production:delete':  ['admin'],
    'production:admin':   ['admin'],

    // ── Finance / Accounts ───────────────────────────────────────────────────
    'finance:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'finance:write':   ['admin', 'accountant'],
    'finance:delete':  ['admin'],
    'finance:admin':   ['admin'],

    // ── Journal Entries ───────────────────────────────────────────────────────
    'journal:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'journal:write':   ['admin', 'accountant'],
    'journal:delete':  ['admin'],
    'journal:admin':   ['admin'],

    // ── Inventory Valuation Reports ──────────────────────────────────────────
    'reports:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'reports:write':   ['admin', 'accountant'],
    'reports:delete':  ['admin'],
    'reports:admin':   ['admin'],

    // ── Customer Orders ───────────────────────────────────────────────────────
    'orders:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'orders:write':   ['admin', 'sales'],
    'orders:delete':  ['admin'],
    'orders:admin':   ['admin'],

    // ── Support & Chat ────────────────────────────────────────────────────────
    'support:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'support:write':   ['admin', 'logistic', 'sales'],
    'support:delete':  ['admin'],
    'support:admin':   ['admin'],

    // ── Supplier Management ───────────────────────────────────────────────────
    'supplier:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'supplier:write':   ['admin', 'procurement'],
    'supplier:delete':  ['admin'],
    'supplier:admin':   ['admin'],

    // ── Marketing Outreach ─────────────────────────────────────────────────────
    'outreach:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'outreach:write':   ['admin', 'sales'],
    'outreach:delete':  ['admin'],
    'outreach:admin':   ['admin'],

    // ── Procurement ─────────────────────────────────────────────────────────────
    'procurement:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'procurement:delete':  ['admin'],

    // ── Factory & Gear Booking ────────────────────────────────────────────────
    'factory:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'factory:write':   ['admin', 'production', 'logistic'],
    'factory:delete':  ['admin'],
    'factory:admin':   ['admin'],

    // ── Warehouse Map ─────────────────────────────────────────────────────────
    'warehouse_map:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'warehouse_map:write':   ['admin', 'production', 'logistic'],
    'warehouse_map:delete':  ['admin'],
    'warehouse_map:admin':   ['admin'],

    // ── Alert Center ─────────────────────────────────────────────────────────
    'alerts:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'alerts:write':   ['admin'],                          // only admin can clear/archive
    'alerts:delete':  ['admin'],
    'alerts:admin':   ['admin'],

    // ── Settings ──────────────────────────────────────────────────────────────
    'settings:read':    ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'],
    'settings:write':   ['admin'],
    'settings:delete':  ['admin'],
    'settings:admin':   ['admin'],
};

// ─── Core helpers ──────────────────────────────────────────────────────────────
// Identity comes from the server-validated espressgo_staff_session cookie,
// surfaced via window.__staffIdentity (populated by components/sidebar.js after
// /api/staff-session/me). No localStorage fallback — that was the privilege
// escalation vector.
//
// We also do an eager probe of /api/staff-session/me right when rbac.js loads,
// BEFORE any page script runs. This solves the classic race where a page does:
//   if (window.RBAC && !window.RBAC.can('staff:write')) lock_screen();
// immediately after <script src="rbac.js">, before the sidebar's async
// connectedCallback has populated __staffIdentity. With the eager probe the
// identity is ready by the time the inline page script runs.

let __identityBootstrapped = false;
function bootstrapStaffIdentity() {
    if (__identityBootstrapped) return;
    __identityBootstrapped = true;
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    // Don't block script load — fire-and-forget. If the page's inline script
    // runs before the fetch completes, the page should `await
    // window.RBAC.identityReady` (see identityReady below).
    fetch('/api/staff-session/me', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
    })
        .then((r) => (r && r.ok ? r.json() : null))
        .then((data) => {
            const session = data && data.session;
            if (session && session.role) {
                window.__staffIdentity = {
                    role: String(session.role),
                    department: session.department || '',
                    email: session.email || '',
                    staff_id: session.staff_id || null,
                    name: session.name || (session.email ? session.email.split('@')[0] : ''),
                };
                window.dispatchEvent(new CustomEvent('staff-identity-ready', { detail: window.__staffIdentity }));
            } else {
                window.__staffIdentity = null;
            }
        })
        .catch(() => {
            window.__staffIdentity = window.__staffIdentity || null;
        });
}

function getCurrentRole() {
    const ident = (typeof window !== 'undefined' && window.__staffIdentity) || null;
    const role = ident && ident.role ? String(ident.role) : null;
    return role && role.length > 0 ? role : null;
}

/**
 * Resolves once the staff session probe (/api/staff-session/me) has produced
 * a role (admin/accountant/…) or a definite null. Pages should `await
 * window.RBAC.identityReady` before calling can()/guardPage()/etc.
 * @returns {Promise<{role: string|null, department: string, email: string}>}
 */
function identityReady() {
    if (typeof window === 'undefined') return Promise.resolve(null);
    if (window.__staffIdentity !== undefined) {
        return Promise.resolve(window.__staffIdentity);
    }
    return new Promise((resolve) => {
        const onReady = (e) => {
            window.removeEventListener('staff-identity-ready', onReady);
            resolve(e && e.detail !== undefined ? e.detail : window.__staffIdentity);
        };
        window.addEventListener('staff-identity-ready', onReady, { once: true });
        // Kick the probe in case rbac.js was loaded standalone without sidebar.js
        bootstrapStaffIdentity();
        // Safety timeout — never block the page forever
        setTimeout(() => {
            window.removeEventListener('staff-identity-ready', onReady);
            resolve(window.__staffIdentity !== undefined ? window.__staffIdentity : null);
        }, 3000);
    });
}

// Kick off the probe immediately on load so __staffIdentity is populated
// as early as possible.
bootstrapStaffIdentity();

// ─── Effective matrix loaded from the server ──────────────────────────────────
// /api/rbac/effective returns the merged {permKey: [roles]} map computed by
// server.js (defaults + overrides from rbac_overrides). We cache it on
// window.__effectiveRbac so can() stays synchronous. Until the load resolves,
// can() falls back to the static PERMISSIONS map above — that's a safe default
// because the server enforces the same rules.
//
// STAFF_ROLES here must match server.js STAFF_ROLES. The admin role is
// always present in every entry of the effective matrix, so can() never has
// to special-case it.
const STAFF_ROLES = ['admin', 'accountant', 'procurement', 'production', 'logistic', 'sales'];

let effectiveRbacPromise = null;
let effectiveRbacCache = null;       // { matrix: Map<perm, Set<role>>, loadedAt, source }

function getEffectiveMatrixMap() {
    if (!effectiveRbacCache) return null;
    return effectiveRbacCache.matrix;
}

function applyEffectiveMatrix(json) {
    const map = new Map();
    const matrix = (json && json.matrix) || {};
    for (const key of Object.keys(matrix)) {
        map.set(key, new Set(matrix[key] || []));
    }
    effectiveRbacCache = {
        matrix: map,
        roles: Array.isArray(json?.roles) ? json.roles : STAFF_ROLES,
        loadedAt: json?.loadedAt || Date.now(),
        source: json?.source || 'unknown',
    };
    return effectiveRbacCache;
}

async function loadEffectiveRBAC({ force = false } = {}) {
    if (effectiveRbacCache && !force) return effectiveRbacCache;
    if (effectiveRbacPromise && !force) return effectiveRbacPromise;
    effectiveRbacPromise = (async () => {
        try {
            const resp = await fetch('/api/rbac/effective', {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
            });
            if (!resp.ok) throw new Error(`effective rbac ${resp.status}`);
            const json = await resp.json();
            return applyEffectiveMatrix(json);
        } catch (err) {
            // Network error → keep using local PERMISSIONS. Don't poison the
            // promise so a later call can retry.
            if (typeof console !== 'undefined' && console.debug) {
                console.debug('[rbac] failed to load /api/rbac/effective, using local defaults:', err.message || err);
            }
            return null;
        } finally {
            effectiveRbacPromise = null;
        }
    })();
    return effectiveRbacPromise;
}

function clearEffectiveRBAC() {
    effectiveRbacCache = null;
}

/**
 * Check if the current user has a specific permission.
 *
 * Resolution order:
 *   1. If /api/rbac/effective has loaded → use that matrix (admin is always
 *      present in every row, so no special-casing needed)
 *   2. Otherwise → fall back to local PERMISSIONS map (safe default; matches
 *      what the server enforces when the cache is empty)
 *
 * @param {string} permission - e.g. 'staff:write', 'finance:read'
 * @returns {boolean}
 */
function can(permission) {
    const role = getCurrentRole();
    if (!role) return false; // fail closed when role is missing
    if (role === 'admin') return true; // admin is always-checked regardless of any state

    const eff = getEffectiveMatrixMap();
    if (eff) {
        const set = eff.get(permission);
        // If the matrix doesn't know about this perm key, deny by default
        // (same posture as the server: unknown permission → false).
        return set ? set.has(role) : false;
    }

    const allowed = PERMISSIONS[permission];
    if (!allowed) return false;
    return allowed.includes(role);
}

/**
 * Check if current role is in a list.
 * @param  {...string} roles
 * @returns {boolean}
 */
function isRole(...roles) {
    const role = getCurrentRole();
    if (!role) return false;
    return roles.includes(role);
}

/**
 * Check if current user has admin privileges.
 * @returns {boolean}
 */
function isAdmin() {
    return getCurrentRole() === 'admin';
}

/**
 * Get the current staff identity (read-only mirror of the cookie payload).
 * Returns null when no session is loaded yet — callers should wait for
 * components/sidebar.js to populate it.
 * RBAC is role-based only; the `department` field is informational and not
 * used for any gate. It's still returned for backwards compatibility with
 * any UI that wants to display it.
 * @returns {{role:string, department:string, email:string} | null}
 */
function getCurrentIdentity() {
    const ident = (typeof window !== 'undefined' && window.__staffIdentity) || null;
    if (!ident || !ident.role) return null;
    return {
        role: ident.role,
        department: ident.department || '',
        email: ident.email || '',
    };
}

/**
 * Get role display name for UI labels.
 * @returns {string}
 */
function getRoleLabel() {
    const labels = {
        admin:       'Administrator',
        accountant:  'Finance & Accounting',
        procurement: 'Procurement',
        production:  'Production',
        logistic:    'Logistics',
        sales:       'Sales & Customer',
        client:      'Customer',
    };
    return labels[getCurrentRole()] || getCurrentRole();
}

// ─── Unified page guard ──────────────────────────────────────────────────────
// All gated pages call one of the helpers below instead of rolling their own
// denied-UI HTML and check-then-throw boilerplate. The helpers render a
// consistent, brand-aligned denial screen and stop script execution by
// throwing — so any code below the call site (e.g. listeners, fetches) is
// never reached when the user isn't authorized.
//
// Three flavours are exposed:
//   - showAccessDenied(opts)            : render-only helper (caller decides gate)
//   - enforcePageAccess(permission, opts): check `can(perm)` → render denied UI on miss
//   - enforceAdminOnly(opts)            : check `isAdmin()` → render denied UI on miss
//
// Options:
//   pageName     : 'Finance & Accounts'                          (required for UI text)
//   permission   : 'finance:read'                                (optional, used in console error)
//   allowedRoles : ['Administrator', 'Accountant']               (optional, role callout in UI)
//   returnHref   : '/'  | '/index.html'                          (optional, default '/')
//   replaceScope : 'body' | 'main'                               (optional, default 'body')

const DEFAULT_RETURN_HREF = '/';

/**
 * Render the canonical "Access Restricted" screen. Replaces either the
 * <body> (full-page takeover) or <main> (in-page inline notice), then throws
 * so any code after the gate never runs.
 *
 * @param {object} [opts]
 * @param {string} [opts.pageName]      Human-readable page name for the message
 * @param {string} [opts.permission]    Permission key (logged in the thrown error)
 * @param {string[]} [opts.allowedRoles] Role names to highlight in the message (e.g. ['Administrators', 'Accountants'])
 * @param {string} [opts.returnHref]    Where the "Return Home" button points (default '/')
 * @param {'body'|'main'} [opts.replaceScope] What to replace (default 'body')
 * @param {string} [opts.heading]       Override the h2 text (default 'Access Restricted')
 * @returns {never}
 */
function showAccessDenied(opts = {}) {
    const {
        pageName = 'this page',
        permission = '',
        allowedRoles = null,
        returnHref = DEFAULT_RETURN_HREF,
        replaceScope = 'body',
        heading = 'Access Restricted',
    } = opts;

    const rolesHtml = (Array.isArray(allowedRoles) && allowedRoles.length)
        ? ` Only <strong>${allowedRoles.join('</strong> and <strong>')}</strong> can access ${pageName}.`
        : ` You do not have permission to access ${pageName}.`;

    const deniedHtml = `
        <div class="min-h-screen flex items-center justify-center bg-slate-50">
            <div class="bg-white border border-red-200 rounded-2xl p-10 text-center shadow-lg max-w-md">
                <span class="material-symbols-outlined text-red-400 text-5xl">lock</span>
                <h2 class="mt-4 text-xl font-extrabold text-slate-800">${heading}</h2>
                <p class="mt-2 text-sm text-slate-500">${rolesHtml} Contact your administrator if you believe this is an error.</p>
                <a href="${returnHref}" class="mt-6 inline-block px-6 py-2 bg-[#031635] text-white text-sm font-bold rounded-xl hover:bg-[#001b3d] transition-colors">Return Home</a>
            </div>
        </div>`;

    const target = (replaceScope === 'main' && document.querySelector('main'))
        ? document.querySelector('main')
        : document.body;
    if (target) target.innerHTML = deniedHtml;

    throw new Error(
        `RBAC: missing permission '${permission || '(unspecified)'}' on page '${pageName}'`
    );
}

/**
 * Block page entry unless the current user has the given permission. Replaces
 * <body> with the canonical denial screen and throws if not allowed.
 *
 * @param {string} permission           e.g. 'finance:read'
 * @param {object}  [opts]               Same shape as showAccessDenied
 * @returns {Promise<void>}
 */
async function enforcePageAccess(permission, opts = {}) {
    await identityReady();
    if (!can(permission)) {
        showAccessDenied({ ...opts, permission });
    }
}

/**
 * Block page entry unless the current user is an admin. Replaces <main> (or
 * <body>) with the canonical denial screen and throws if not allowed.
 *
 * @param {object} [opts]               Same shape as showAccessDenied
 * @returns {Promise<void>}
 */
async function enforceAdminOnly(opts = {}) {
    await identityReady();
    if (!isAdmin()) {
        showAccessDenied({
            pageName: opts.pageName || 'this admin-only area',
            allowedRoles: ['Administrators'],
            replaceScope: opts.replaceScope || 'main',
            ...opts,
            permission: opts.permission || 'staff:write',
        });
    }
}

// ─── Page guard (legacy redirect flavour) ───────────────────────────────────
// Redirect-away behaviour kept for callers that want a bounce (e.g. pages
// that don't render their own denial UI). New code should prefer
// enforcePageAccess() above.

const UNAUTHORIZED_REDIRECT = '/index.html';

/**
 * Redirect away from the current page if the user lacks the required permission.
 * Call at the top of any page's <script> block.
 *
 * @param {string} permission - e.g. 'salary:write'
 * @param {string} [fallbackRedirect] - optional custom redirect URL
 */
function guardPage(permission, fallbackRedirect) {
    if (!can(permission)) {
        const redirect = fallbackRedirect || UNAUTHORIZED_REDIRECT;
        // Small delay so the page doesn't flash then immediately redirect
        setTimeout(() => {
            window.location.href = redirect;
        }, 100);
        return false;
    }
    return true;
}

/**
 * Guard a single permission OR a list (user needs at least one).
 */
function guardPageAny(permissions, fallbackRedirect) {
    const allowed = permissions.some(p => can(p));
    if (!allowed) {
        setTimeout(() => {
            window.location.href = fallbackRedirect || UNAUTHORIZED_REDIRECT;
        }, 100);
        return false;
    }
    return true;
}

// ─── Sidebar section visibility by role ──────────────────────────────────────
// Each sidebar section declares which roles can see it. role === 'admin'
// always sees every section (handled in the helper).
// This is the primary filter; per-item filtering still uses NAV_PERMISSIONS
// below.
//
// RBAC is ROLE-BASED ONLY in this project — department is informational only
// (shown on the staff record and in identity headers), but never gates access.
// If you need to widen or narrow a section, edit `roles:` here, or use the
// admin RBAC page to grant/deny the underlying permissions.
const ALL_STAFF_ROLES = ['admin','accountant','procurement','production','logistic','sales'];

const ROLE_SECTION_ACCESS = {
    'Business Ops':         { roles: ALL_STAFF_ROLES },
    'Communication Hub':    { roles: ALL_STAFF_ROLES },
    'Finances & Reports':   { roles: ALL_STAFF_ROLES },
    'Document Hub':         { roles: ALL_STAFF_ROLES },
    'Logistics & Dispatch': { roles: ALL_STAFF_ROLES },
    'Warehouse':            { roles: ALL_STAFF_ROLES },
    'Staff Management':     { roles: ['admin'] },
    'Settings & Security':  { roles: ['admin'] },
};

/**
 * Decide whether the current user is allowed to see a given sidebar section.
 * Department is intentionally NOT consulted — RBAC is role-based only.
 * @param {string} sectionTitle - the section title (e.g. 'Business Ops')
 * @param {string} [role] - optional override; defaults to window.__staffIdentity.role
 * @returns {boolean}
 */
function canSeeSection(sectionTitle, role) {
    const r = role ?? getCurrentRole();
    if (!r) return false; // fail closed when role is missing
    if (r === 'admin') return true;
    const rule = ROLE_SECTION_ACCESS[sectionTitle];
    if (!rule) return false;
    return rule.roles.includes(r);
}

// ─── Nav item visibility ───────────────────────────────────────────────────────
// Maps nav item IDs (from sidebar.js) to required permissions.
// An empty array = visible to everyone.

const NAV_PERMISSIONS = {
    'supplier-management':   'supplier:read',
    'customer-master':       'orders:read',
    'sales-dashboard':       'orders:read',
    'outreach':              'outreach:read',
    'support-hub':           'support:read',
    'finance-dashboard':      'finance:read',
    'traceability':          'production:read',
    'purchase-record':        'procurement:read',
    'fulfillment':           'orders:read',
    'returns':               'orders:read',
    'warehouse-stock':      'inventory:read',
    'production':            'production:read',
    'production-recipes':    'recipes:read',
    'factory-booking':       'factory:read',
    'staff-management':      'staff:read',
    'create-staff':          'staff:write',
    'staff-salaries':        'salary:read',
    'rbac-admin':            'staff:write',   // admin-only (server: staff:write = admin)
    'alert-center':          'alerts:write',  // admin-only by default
};

// ─── Module → pages mapping (for server-side enforcement) ─────────────────────

/**
 * Maps URL paths to required permissions for write operations.
 * Used by server.js to enforce RBAC at the API level.
 */
const PAGE_WRITE_PERMISSIONS = {
    '/staff-management/salaries.html':      'salary:write',
    '/staff-management/create-staff.html':   'staff:write',
    '/business-management/finances/':        'finance:write',
    '/business-management/finances/account-detail.html': 'journal:write',
    '/production/index.html':                'production:write',
    '/warehouse/inventory.html':             'inventory:write',
    '/warehouse/recipes.html':              'recipes:write',
    '/business-management/Supplier-management/': 'supplier:write',
    '/business-management/outreach/':         'outreach:write',
    '/factory-booking/index.html':           'factory:write',
    '/settings/alert-center.html':           'alerts:write',
};

// ─── UI Helpers ───────────────────────────────────────────────────────────────

/**
 * Hide or show an element based on permission.
 * Usage: <div data-rbac="staff:write">...</div>  ← element will be hidden if not allowed
 *
 * Call once on DOMContentLoaded after this script loads.
 */
function applyRBACToDOM() {
    document.querySelectorAll('[data-rbac]').forEach(el => {
        const perm = el.getAttribute('data-rbac');
        if (!can(perm)) {
            el.style.display = 'none';
        }
    });

    // Also handle data-rbac-any (show if ANY of the listed permissions match)
    document.querySelectorAll('[data-rbac-any]').forEach(el => {
        const perms = el.getAttribute('data-rbac-any').split(',').map(p => p.trim());
        if (!perms.some(p => can(p))) {
            el.style.display = 'none';
        }
    });

    // data-rbac-only — show ONLY to these roles
    document.querySelectorAll('[data-rbac-only]').forEach(el => {
        const roles = el.getAttribute('data-rbac-only').split(',').map(r => r.trim());
        if (!roles.includes(getCurrentRole())) {
            el.style.display = 'none';
        }
    });
}

// Auto-apply on DOM ready if loaded as a module
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', applyRBACToDOM);
}

// ─── Auto-load effective matrix ────────────────────────────────────────────────
// Fire-and-forget load on first script execution. Any module that needs the
// effective matrix should call `await RBAC.loadEffective()`; until it resolves,
// can() uses the local PERMISSIONS defaults (same answer the server gives
// when its cache is cold, so no behaviour mismatch).
if (typeof window !== 'undefined' && !effectiveRbacCache) {
    loadEffectiveRBAC();
}

// ─── Extra staff pages not exposed via the sidebar ────────────────────────────
// Some pages exist for admins only (or are reached via deep links) and never
// appear in components/sidebar.js NAV_ITEMS. They still need to show up in the
// RBAC admin "Page Access" tab. List them here; the UI merges them with the
// auto-discovered list and shows a "manual" badge.
//
// Declared BEFORE window.RBAC so the export below can reference it without
// hitting the const TDZ.
const EXTRA_STAFF_PAGES = [
    { id: 'rbac-admin',     path: '/settings/rbac.html',         label: 'RBAC Admin' },
    { id: 'alert-center',   path: '/settings/alert-center.html', label: 'Alert Center' },
    // Protected files (account.html / account-detail.html) — never edit the
    // .html files themselves; enforcement lives entirely in the catalog +
    // server route guard. `requiredRole` locks these rows to admin+accountant
    // regardless of any role-toggle the RBAC admin flips.
    { id: 'finance-account',         path: '/business-management/finances/account.html',         label: 'Finance Account Ledger',     requiredRole: 'accountant' },
    { id: 'finance-account-detail',  path: '/business-management/finances/account-detail.html',  label: 'Finance Account Detail',     requiredRole: 'accountant' },
    // View-only / public pages — listed in the catalog so admins can see them,
    // but NOT server-gated (the static handler lets them through). They render
    // greyed-out with all checkboxes pre-checked; no toggle changes anything.
    { id: 'staff-login',                   path: '/index.html',                                          label: 'Staff Login',                viewOnly: true },
    { id: 'customer-portal-home',          path: '/customer-page/index.html',                            label: 'Customer Portal Home',       viewOnly: true },
    { id: 'customer-b2c-store',            path: '/customer-page/Retail/b2c.html',                       label: 'B2C Retail Store',           viewOnly: true },
    { id: 'customer-b2c-login',            path: '/customer-page/Retail/b2c-login.html',                 label: 'B2C Retail Login',           viewOnly: true },
    { id: 'customer-b2b-store',            path: '/customer-page/wholesales/b2b.html',                   label: 'B2B Wholesale Store',        viewOnly: true },
    { id: 'customer-b2b-login',            path: '/customer-page/wholesales/b2b-login.html',             label: 'B2B Wholesale Login',        viewOnly: true },
    { id: 'customer-b2b-onboarding',       path: '/customer-page/wholesales/business-onboarding.html',   label: 'B2B Business Onboarding',    viewOnly: true },
];

// ─── Staff pages reachable via deep links but not via the sidebar ──────────────
// These pages ARE staff-facing and need an RBAC row, but they're never picked
// up by the sidebar auto-discover (no navSections entry). Common reasons:
//   - opened from a button on another page (e.g. "View Timeline" from the
//     Customer Master row)
//   - a sub-page of a section that doesn't expose all children in nav
//   - admin-only maintenance flows (onboarding, verification)
// The UI merges these into the "Page Access" tab with a `deep-link` badge.
const DEEP_LINK_STAFF_PAGES = [
    // Customer detail / history drilldowns
    { id: 'customer-timeline',          path: '/business-management/customer-management/customer-timeline.html',          label: 'Customer Timeline' },
    { id: 'customer-verification',      path: '/business-management/customer-management/big-business/customer-verification.html', label: 'B2B Verification' },
    { id: 'sales-dashboard-b2c',        path: '/business-management/customer-management/customer-order/b2c.html',          label: 'B2C Retail Orders' },

    // Supplier detail / onboarding drilldowns
    { id: 'supplier-details',           path: '/business-management/Supplier-management/details.html',                  label: 'Supplier Profile' },
    { id: 'supplier-onboard',           path: '/business-management/Supplier-management/onboard.html',                  label: 'Supplier Onboarding' },
    { id: 'supplier-timeline',          path: '/business-management/Supplier-management/timeline.html',                 label: 'Supplier Timeline' },
];

// ─── Expose globally ───────────────────────────────────────────────────────────
window.RBAC = {
    can,
    isRole,
    isAdmin,
    getRole: getCurrentRole,
    getRoleLabel,
    guardPage,
    guardPageAny,
    enforcePageAccess,
    enforceAdminOnly,
    showAccessDenied,
    identityReady,
    bootstrapStaffIdentity,
    NAV_PERMISSIONS,
    EXTRA_STAFF_PAGES,
    DEEP_LINK_STAFF_PAGES,
    ROLE_SECTION_ACCESS,
    canSeeSection,
    PAGE_WRITE_PERMISSIONS,
    applyRBACToDOM,
    PERMISSIONS,
    STAFF_ROLES,
    loadEffective: loadEffectiveRBAC,
    clearEffective: clearEffectiveRBAC,
    getEffective: () => effectiveRbacCache,
};

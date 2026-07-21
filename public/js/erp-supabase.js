(function () {
const SUPABASE_URL = 'https://qsobpenorlpzlkeyiefg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzb2JwZW5vcmxwemxrZXlpZWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NDMwOTEsImV4cCI6MjA5MjMxOTA5MX0.RBJsOWvF0vfX_e6q_y2zpzvBKh_PA73cZ55I7CAm8M4';

    const DEFAULT_API_ORIGIN = 'http://localhost:3000';
    const STATIC_DEV_PORTS = new Set(['5500', '5501', '8000', '8080']);

    const roleAliases = {
        admin: 'admin',
        accountant: 'accountant',
        finance: 'accountant',
        procurement: 'procurement',
        procure: 'procurement',
        production: 'production',
        logistic: 'logistic',
        logistics: 'logistic',
        sales: 'sales',
        client: 'client',
        customer: 'client',
    };

    function loadSupabaseSdk() {
        return new Promise((resolve) => {
            if (window.supabase && window.supabase.createClient) {
                console.log('[erp-supabase] loadSupabaseSdk: found existing window.supabase');
                resolve(window.supabase);
                return;
            }

            const existing = document.querySelector('script[src*="supabase-js"]');
            if (existing) {
                existing.addEventListener('load', () => resolve(window.supabase));
                existing.addEventListener('error', () => resolve(null));
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
            script.onload = () => resolve(window.supabase);
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        });
    }

    function readLocalStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function isLoopbackHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    }

    function shouldUseExternalApiOrigin() {
        const location = window.location;
        if (!location) return false;
        if (location.protocol === 'file:') return true;
        return isLoopbackHost(location.hostname) && STATIC_DEV_PORTS.has(location.port);
    }

    function getApiOrigin() {
        const explicit = window.ERP_API_ORIGIN || readLocalStorage('erp-api-origin') || '';
        if (explicit) return String(explicit).replace(/\/$/, '');
        return shouldUseExternalApiOrigin() ? DEFAULT_API_ORIGIN : '';
    }

    function apiUrl(pathname) {
        const path = String(pathname || '/api/supabase');
        const origin = getApiOrigin();
        return origin ? `${origin}${path.startsWith('/') ? path : `/${path}`}` : path;
    }

    function installSupabaseSingleton(sdk) {
        if (!sdk || !sdk.createClient) { console.warn('[erp-supabase] installSupabaseSingleton: no sdk or no createClient'); return; }
        if (sdk.__erpCreateClientPatched) { console.log('[erp-supabase] already patched'); return; }
        console.log('[erp-supabase] patching createClient');
        const nativeCreateClient = sdk.createClient.bind(sdk);
        sdk.__erpNativeCreateClient = nativeCreateClient;
        sdk.__erpCreateClientPatched = true;
        sdk.createClient = function (url, key, options = {}) {
            const isErpProject = String(url || '') === SUPABASE_URL && String(key || '') === SUPABASE_ANON_KEY;
            if (isErpProject && sdk._client) return sdk._client;

            const mergedOptions = isErpProject
                ? {
                    ...options,
                    auth: {
                        storageKey: 'erp-supabase-auth',
                        ...(options.auth || {}),
                    },
                }
                : options;

            const client = nativeCreateClient(url, key, mergedOptions);
            if (isErpProject) sdk._client = client;
            return client;
        };
    }

    async function initSupabaseClient() {
        console.log('[erp-supabase] initSupabaseClient called');
        const sdk = await loadSupabaseSdk();
        if (!sdk || !sdk.createClient) return null;
        installSupabaseSingleton(sdk);
        if (window.supabase && window.supabase._client) return window.supabase._client;

        const client = sdk.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { storageKey: 'erp-supabase-auth' },
        });
        window.supabase._client = client;
        return client;
    }

    async function getAccessToken() {
        try {
            const client = await initSupabaseClient();
            if (!client?.auth) return localStorage.getItem('supabase-access-token') || null;
            const { data } = await client.auth.getSession();
            return data?.session?.access_token || localStorage.getItem('supabase-access-token') || null;
        } catch {
            return localStorage.getItem('supabase-access-token') || null;
        }
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getCurrentUser() {
        // Read from window.__staffIdentity (populated by the sidebar from the
        // server cookie) — never from localStorage, never with an admin
        // default. When no session is present, return nulls; the server will
        // stamp the audit row with 'system' in that case.
        const ident = (typeof window !== 'undefined' && window.__staffIdentity) || null;
        return {
            email: ident && ident.email ? ident.email : null,
            role:  ident && ident.role  ? ident.role  : null,
        };
    }

    async function fetchSupabaseProxy(payload) {
        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const fetcher = nativeFetch || window.fetch.bind(window);
                const enrichedPayload = { ...payload };
                // Stamp user identity on every mutation so the server can attribute it.
                // user_role / user_email come from the verified
                // espressgo_staff_session cookie server-side; we send the body
                // fields only when the cookie proves a session exists, so the
                // server can sanity-check that they match.
                const mutationOps = new Set(['insert', 'upsert', 'update', 'delete']);
                if (payload && payload.operation && mutationOps.has(payload.operation)) {
                    const { email, role } = getCurrentUser();
                    if (email) enrichedPayload.user_email = email;
                    if (role)  enrichedPayload.user_role  = role;
                }
                const resp = await fetcher(apiUrl('/api/supabase'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(enrichedPayload),
                });

                if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
                    const retryAfter = Number(resp.headers.get('retry-after'));
                    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                        ? retryAfter * 1000
                        : 250 * (attempt + 1);
                    await delay(delayMs);
                    continue;
                }

                return resp;
            } catch (error) {
                lastError = error;
                if (attempt >= 2) break;
                await delay(250 * (attempt + 1));
            }
        }

        throw lastError || new Error('Supabase proxy request failed');
    }

    // Client-side request cache with 30s TTL for reads (performance optimization)
    const requestCache = new Map();
    const CLIENT_CACHE_TTL_MS = 30000;

    async function executeDirectSelect(payload) {
        const { table, columns, filters, order, ascending, limit, range, embed } = payload;
        if (!table) throw new Error('Table name is required for select operation');

        const client = window.supabase._client;
        if (!client) throw new Error('Supabase client not initialized');
        
        let selectStr = '*';
        if (columns) {
            selectStr = Array.isArray(columns) ? columns.join(',') : columns;
        }
        if (embed) {
            selectStr = embed;
        }

        let query = client.from(table).select(selectStr);

        if (Array.isArray(filters)) {
            for (const f of filters) {
                if (!f || typeof f !== 'object') continue;
                const { col, op, val } = f;
                if (!col || !op) continue;

                const operator = String(op).toLowerCase();
                switch (operator) {
                    case 'eq':
                        query = query.eq(col, val);
                        break;
                    case 'neq':
                        query = query.neq(col, val);
                        break;
                    case 'gt':
                        query = query.gt(col, val);
                        break;
                    case 'gte':
                        query = query.gte(col, val);
                        break;
                    case 'lt':
                        query = query.lt(col, val);
                        break;
                    case 'lte':
                        query = query.lte(col, val);
                        break;
                    case 'like':
                        query = query.like(col, val);
                        break;
                    case 'ilike':
                        query = query.ilike(col, val);
                        break;
                    case 'is':
                        query = query.is(col, val);
                        break;
                    case 'in':
                        query = query.in(col, Array.isArray(val) ? val : [val]);
                        break;
                    default:
                        query = query.filter(col, op, val);
                }
            }
        }

        if (order) {
            query = query.order(order, { ascending: ascending !== false });
        }

        if (typeof limit === 'number') {
            query = query.limit(limit);
        }

        if (range && typeof range.start === 'number' && typeof range.end === 'number') {
            query = query.range(range.start, range.end);
        }

        const { data, error } = await query;
        if (error) {
            throw error;
        }
        return data || [];
    }

    async function supabaseAPI(payload) {
        const normalizedPayload = payload && typeof payload === 'object' ? { ...payload } : {};
        if (normalizedPayload.data && typeof normalizedPayload.data === 'object') {
            const rows = Array.isArray(normalizedPayload.data) ? normalizedPayload.data : [normalizedPayload.data];
            rows.forEach((row) => {
                if (row && typeof row === 'object' && row.payment_status === 'Pending approval') {
                    row.payment_status = 'Pending';
                }
            });
        }

        // Client-side caching for SELECT operations
        const isReadOp = normalizedPayload.operation === 'select';
        if (isReadOp) {
            const cacheKey = JSON.stringify(normalizedPayload);
            const now = Date.now();
            const cached = requestCache.get(cacheKey);
            if (cached && now < cached.expiry) {
                return cached.data;
            }
        }

        // Direct-read routing
        if (isReadOp && window.ERP_DIRECT_READS !== false && window.supabase?._client) {
            try {
                const data = await executeDirectSelect(normalizedPayload);
                const cacheKey = JSON.stringify(normalizedPayload);
                requestCache.set(cacheKey, { data: data || [], expiry: Date.now() + CLIENT_CACHE_TTL_MS });
                return data;
            } catch (err) {
                console.warn('[erp-supabase] Direct read failed, falling back to proxy:', err);
            }
        }

        const resp = await fetchSupabaseProxy(normalizedPayload);

        let result;
        try {
            result = await resp.json();
        } catch {
            result = { data: null, error: `HTTP ${resp.status}` };
        }

        if (!resp.ok) {
            throw new Error(result.error || `Supabase operation failed with HTTP ${resp.status}`);
        }

        if (result.error && result.data !== undefined) {
            return result.data;
        }

        if (result.error) {
            throw new Error(result.error);
        }

        // Cache successful reads
        if (isReadOp && resp.ok) {
            const cacheKey = JSON.stringify(normalizedPayload);
            requestCache.set(cacheKey, { data: result.data || [], expiry: Date.now() + CLIENT_CACHE_TTL_MS });
        }

        // Always return a defined value (array for reads, null for writes like DDL that return no rows)
        if (result.data === undefined) return null;
        return result.data || [];
    }

    // Invalidate cache for a given table (call after mutations)
    function invalidateTableCache(tableName) {
        const tablePrefix = `"table":"${tableName}"`;
        for (const key of requestCache.keys()) {
            if (key.includes(tablePrefix)) {
                requestCache.delete(key);
            }
        }
    }

    // Expose cache invalidation globally for mutation handlers
    window.invalidateSupabaseCache = window.invalidateSupabaseCache || invalidateTableCache;

    const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    if (nativeFetch && !window.__erpFetchPatched) {
        window.__erpFetchPatched = true;
        window.fetch = async function (resource, options) {
            const url = typeof resource === 'string' ? resource : resource?.url || '';
            if (url.includes('/functions/v1/api-gateway')) {
                return nativeFetch(apiUrl('/api/supabase'), {
                    method: options?.method || 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: options?.body || '{}',
                });
            }

            try {
                const parsedUrl = new URL(url, window.location.origin);
                const proxyOrigin = getApiOrigin();
                if (proxyOrigin && parsedUrl.origin === window.location.origin && parsedUrl.pathname.startsWith('/api/')) {
                    return nativeFetch(`${proxyOrigin}${parsedUrl.pathname}${parsedUrl.search}`, options);
                }
            } catch {
                // Non-URL fetch resources should continue through the browser unchanged.
            }

            return nativeFetch(resource, options);
        };
    }

    function inferRoleFromEmail(email) {
        const value = String(email || '').trim().toLowerCase();
        const prefix = value.split('@')[0];
        if (roleAliases[value]) return roleAliases[value];
        if (roleAliases[prefix]) return roleAliases[prefix];
        if (value.includes('admin')) return 'admin';
        if (value.includes('finance')) return 'accountant';
        if (value.includes('procure')) return 'procurement';
        if (value.includes('production') || value.includes('produce')) return 'production';
        if (value.includes('logistic')) return 'logistic';
        if (value.includes('sales')) return 'sales';
        if (value.includes('client') || value.includes('sarah') || value.includes('customer')) return 'client';
        return 'sales';
    }

    window.ERP_SUPABASE_URL = SUPABASE_URL;
    window.ERP_SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
    window.ERP_API_ORIGIN = window.ERP_API_ORIGIN || getApiOrigin();
    window.erpApiUrl = apiUrl;
    window.initSupabaseClient = window.initSupabaseClient || initSupabaseClient;
    window.getAccessToken = window.getAccessToken || getAccessToken;
    window.supabaseAPI = window.supabaseAPI || supabaseAPI;
    window.erpSupabaseAPI = supabaseAPI;
    window.erpInferRole = inferRoleFromEmail;

    if (window.supabase && window.supabase.createClient) {
        installSupabaseSingleton(window.supabase);
    }
    initSupabaseClient();

    // Define the Realtime synchronous stub so pages can call refreshOn/on/off before realtime.js finishes loading.
    if (!window.ERPRealtime) {
        window.ERPRealtime = {
            _pending: [],
            on: function (table, handler) {
                const sub = { type: 'on', table, handler };
                this._pending.push(sub);
                return {
                    unsubscribe: () => {
                        const idx = this._pending.indexOf(sub);
                        if (idx !== -1) this._pending.splice(idx, 1);
                        if (sub.realUnsubscribe) sub.realUnsubscribe();
                    }
                };
            },
            off: function (table, handler) {
                this._pending.push({ type: 'off', table, handler });
            },
            refreshOn: function (table, reloadFn, opts) {
                const sub = { type: 'refreshOn', table, reloadFn, opts };
                this._pending.push(sub);
            },
            ignore: function (table) {
                this._pending.push({ type: 'ignore', table });
            }
        };

        // Dynamically inject realtime.js
        const script = document.createElement('script');
        script.src = '/public/js/realtime.js';
        document.head.appendChild(script);
    }
})();

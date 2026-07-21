    const SUPABASE_URL = 'https://qsobpenorlpzlkeyiefg.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzb2JwZW5vcmxwemxrZXlpZWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NDMwOTEsImV4cCI6MjA5MjMxOTA5MX0.RBJsOWvF0vfX_e6q_y2zpzvBKh_PA73cZ55I7CAm8M4';
    // Use a script-block-local binding (`supabaseClient`) instead of a top-level
    // `supabase` const so this file is safe to load on any page that already has
    // a `const supabase` declared in classic-script scope (e.g. customer-page/
    // index.html). `window.supabase` itself is still the SDK global set by
    // `@supabase/supabase-js` — that property access stays as-is.
    const supabaseClient = (window.supabase && window.supabase._client)
        ? window.supabase._client
        : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Returns a fresh access token from the live SDK session.
    async function getAccessToken() {
        const client = (window.supabase && window.supabase._client) ? window.supabase._client : supabaseClient;
        if (client) {
            const { data: { session } } = await client.auth.getSession();
            return session ? session.access_token : null;
        }
        return null;
    }

    // ── Server-backed session helpers ─────────────────────────────────────────
    // The portal no longer keeps auth state in localStorage. Session lives in
    // an httpOnly cookie set by `/api/session/*`; the browser can only check
    // "am I logged in?" via `/api/session/me` and trigger login/register/logout.
    async function fetchSessionFromServer() {
        try {
            const resp = await fetch('/api/session/me', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Cache-Control': 'no-store' },
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            return data && data.session ? data.session : null;
        } catch {
            return null;
        }
    }

    async function loginViaServer({ email, password, segment }) {
        const resp = await fetch('/api/session/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, segment }),
        });
        let data = null;
        try {
            data = await resp.json();
        } catch {
            throw new Error(`Sign-in failed (HTTP ${resp.status})`);
        }
        if (!resp.ok || data.error) {
            throw new Error(data.error || `Sign-in failed (HTTP ${resp.status})`);
        }
        return data.session;
    }

    async function registerViaServer({ email, password, name, company, segment, phone, address }) {
        const resp = await fetch('/api/session/register', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, name, company, segment, phone, address }),
        });
        let data = null;
        try {
            data = await resp.json();
        } catch {
            throw new Error(`Sign-up failed (HTTP ${resp.status})`);
        }
        if (!resp.ok || data.error) {
            throw new Error(data.error || `Sign-up failed (HTTP ${resp.status})`);
        }
        return data.session;
    }

    async function logoutViaServer() {
        try {
            await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin' });
        } catch {
            // ignore — we'll still clear local UI state below
        }
    }


    // --- Local Supabase proxy helper ---
    async function supabaseAPI({ table, operation, data, filters, columns, returning, onConflict }) {
        if (typeof window.erpSupabaseAPI === 'function') {
            return window.erpSupabaseAPI({ table, operation, data, filters, columns, returning, onConflict });
        }

        // Always include credentials so the server can attach the session
        // cookie; the server overrides `user_role`/`user_email` from the
        // verified cookie so we don't bother sending them from the body.
        const resp = await fetch('/api/supabase', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table, operation, data, filters, columns, returning, onConflict })
        });
        let result;
        try {
            result = await resp.json();
        } catch {
            throw new Error(`HTTP ${resp.status}: non-JSON response`);
        }
        if (!resp.ok || result.error) {
            const err = new Error(result.error || `HTTP ${resp.status}`);
            err.code = result.code || null;
            err.status = resp.status;
            err.product_name = result.product_name || null;
            err.short = typeof result.short === 'number' ? result.short : null;
            err.requested = typeof result.requested === 'number' ? result.requested : null;
            err.fulfillment_id = result.fulfillment_id || null;
            throw err;
        }
        return Array.isArray(result.data) ? result.data : [];
    }

    const BACKEND_KEY = 'espressgo-customer-backend';
    const LEGACY_ORDERS_KEY = 'customer-orders';
    const CART_PREFIX = 'espressgo-customer-cart-';

    // One-time cleanup: nuke any pre-cookie session blobs so a returning user
    // doesn't see a stale "logged in" UI before the real /api/session/me
    // round-trip completes.
    try {
        localStorage.removeItem('espressgo-customer-session-b2c');
        localStorage.removeItem('espressgo-customer-session-b2b');
        localStorage.removeItem('erp-use-auth');
    } catch {
        /* localStorage may be blocked in some sandboxes */
    }

    function readJSON(key, fallback) {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        try {
            return JSON.parse(raw);
        } catch {
            return fallback;
        }
    }

    function saveJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function mirrorLegacyOrders(backend) {
        saveJSON(LEGACY_ORDERS_KEY, backend.orders);
    }

    function money(value) {
        return `$${Number(value || 0).toFixed(2)}`;
    }

    function shortDate(value) {
        return new Date(value).toLocaleDateString('en-SG', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    }

    function shortDateTime(value) {
        return new Date(value).toLocaleString('en-SG', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function cartKey(segment) {
        return `${CART_PREFIX}${segment}`;
    }

    function trackNumber(segment) {
        return `NV-${segment.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    }

    function orderId(segment) {
        return `ORD-${segment.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    }

    function defaultBackend() {
        return { orders: [], chats: {}, lastSyncAt: Date.now() };
    }

    function seedThread(order, config) {
        return [
            {
                id: `${order.id}-sys-1`,
                sender_id: 'system',
                sender_name: 'System',
                message_text: `Order ${order.id} has been received and is being processed.`,
                created_at: new Date(order.createdAt).toISOString(),
                is_system: true
            },
            {
                id: `${order.id}-staff-1`,
                sender_id: 'staff',
                sender_name: config.staff.name,
                message_text: `Hello! I'm ${config.staff.name}, your ${config.staff.role}. I'll be assisting with this order.`,
                created_at: new Date(order.createdAt + 60000).toISOString(),
                is_system: false
            }
        ];
    }

    function ensureBackend(config) {
        const backend = readJSON(BACKEND_KEY, defaultBackend());
        if (!Array.isArray(backend.orders)) backend.orders = [];
        if (!backend.chats) backend.chats = {};
        return backend;
    }

    function loadCart(segment) {
        return readJSON(cartKey(segment), []);
    }

    function saveCart(segment, cart) {
        saveJSON(cartKey(segment), cart);
    }

    function updateStatusFromAge(order) {
        // This is a UX-only heuristic for orders that never reached the
        // backend (e.g. demo / preview data). It must NEVER mutate the
        // status of an order we persisted — the server is the source of
        // truth for real fulfillment state, and racing a fake progression
        // into a row the staff actually care about would mislead everyone
        // who reads the dashboard. Skip when dbId is set.
        if (order && order.dbId) return false;

        const ageSeconds = (Date.now() - order.createdAt) / 1000;
        const nextStatus =
            ageSeconds > 36 ? 'Delivered' :
            ageSeconds > 22 ? 'Shipped' :
            ageSeconds > 10 ? 'Packed' :
            ageSeconds > 3 ? 'Processing' :
            order.status || 'Confirmed';

        if (order.status !== nextStatus) {
            order.status = nextStatus;
            order.updatedAt = Date.now();
            if (nextStatus === 'Delivered') {
                order.deliveryDate = shortDate(Date.now());
                order.deliveredDate = shortDate(Date.now());
            }
            return true;
        }

        return false;
    }

    function appendChatMessage(backend, orderId, message) {
        if (!backend.chats[orderId]) backend.chats[orderId] = [];
        backend.chats[orderId].push({
            id: `${orderId}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            ...message
        });
    }

    // ── Toast / in-app notifications ──────────────────────────────────────────
    // Minimal dependency-free toast UI. Used to surface async failures (e.g.
    // a chat message that didn't actually reach the backend) so the user
    // doesn't see a "sent" message that nobody else can read.
    function ensureToastRoot() {
        let root = document.getElementById('erp-toast-root');
        if (root) return root;
        if (!document.getElementById('erp-toast-styles')) {
            const style = document.createElement('style');
            style.id = 'erp-toast-styles';
            style.textContent = '@keyframes erp-toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
            document.head.appendChild(style);
        }
        root = document.createElement('div');
        root.id = 'erp-toast-root';
        root.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;max-width:340px;';
        document.body.appendChild(root);
        return root;
    }

    function showToast({ message, tone = 'error', actionLabel, onAction, ttlMs = 6000 } = {}) {
        const root = ensureToastRoot();
        const el = document.createElement('div');
        const palette = tone === 'error'
            ? { bg: '#7f1d1d', fg: '#fff', border: '#fca5a5' }
            : tone === 'success'
                ? { bg: '#065f46', fg: '#fff', border: '#6ee7b7' }
                : { bg: '#0f172a', fg: '#fff', border: '#94a3b8' };
        el.style.cssText = `background:${palette.bg};color:${palette.fg};border:1px solid ${palette.border};border-radius:8px;padding:12px 14px;font:600 13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.25);pointer-events:auto;display:flex;flex-direction:column;gap:6px;animation:erp-toast-in 200ms ease-out;`;
        const msg = document.createElement('div');
        msg.textContent = message;
        msg.style.cssText = 'opacity:0.95;word-break:break-word;';
        el.appendChild(msg);
        if (actionLabel && typeof onAction === 'function') {
            const btn = document.createElement('button');
            btn.textContent = actionLabel;
            btn.style.cssText = 'background:transparent;border:1px solid currentColor;color:inherit;border-radius:4px;padding:4px 10px;font:700 11px/1 inherit;letter-spacing:0.05em;text-transform:uppercase;cursor:pointer;align-self:flex-start;';
            btn.onclick = () => {
                try { onAction(); } finally { el.remove(); }
            };
            el.appendChild(btn);
        }
        root.appendChild(el);
        if (ttlMs > 0) {
            setTimeout(() => {
                if (el.parentNode) {
                    el.style.transition = 'opacity 200ms';
                    el.style.opacity = '0';
                    setTimeout(() => el.remove(), 220);
                }
            }, ttlMs);
        }
        return el;
    }

    function buildOrder(config, session, cart) {
        const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
        const createdAt = Date.now();
        const lines = cart.map((item) => `${item.qty} x ${item.name}`).join(' | ');
        const backendOrder = {
            id: orderId(config.segment),
            order_number: orderId(config.segment),
            segment: config.segment,
            createdAt,
            updatedAt: createdAt,
            clientName: session.name,
            companyName: session.company,
            product: lines,
            item: lines,
            qty: cart.map((item) => `${item.qty}x ${item.name}`).join(', '),
            amount: money(total),
            paymentStatus: config.segment === 'b2b' ? 'Pending approval' : 'Paid',
            status: 'Confirmed',
            carrier: config.segment === 'b2b' ? 'NinjaVan Express B2B' : 'NinjaVan Retail Express',
            trackingNum: trackNumber(config.segment),
            eta: shortDate(Date.now() + 4 * 86400000),
            deliveryDate: shortDate(Date.now() + 4 * 86400000),
            deliveredDate: 'Pending',
            staffName: config.staff.name,
            staffRole: config.staff.role,
            cartItems: cart // Store cart items for Supabase order_items insertion
        };

        return backendOrder;
    }

    function renderTimeline(order) {
        const steps = [
            ['Confirmed', 'Order saved and queued in the backend.'],
            ['Packed', 'Warehouse packing and labeling in progress.'],
            ['Shipped', 'Carrier pickup and live tracking updates active.']
        ];

        return steps.map((step, index) => {
            const active = (order.status === 'Delivered' || index < 3 && (
                (order.status === 'Shipped' && index <= 2) ||
                (order.status === 'Packed' && index <= 1) ||
                (order.status === 'Processing' && index === 0) ||
                (order.status === 'Confirmed' && index === 0)
            ));
            return `
                <div class="flex gap-4">
                    <div class="w-8 h-8 rounded-full ${active ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-500'} flex items-center justify-center shrink-0 shadow-sm border border-white/5">
                        <span class="material-symbols-outlined text-sm">${index === 0 ? 'check' : index === 1 ? 'inventory_2' : 'local_shipping'}</span>
                    </div>
                    <div class="flex-1 pb-4 border-b border-white/5 last:border-b-0">
                        <div class="text-xs font-extrabold text-white uppercase tracking-wider">${step[0]}</div>
                        <div class="text-[10px] text-neutral-400 font-medium mt-1 leading-relaxed">${step[1]}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function init(config) {
        const els = {
            authPanel: document.getElementById('auth-panel'),
            loginPanel: document.getElementById('login-panel'),
            sessionPanel: document.getElementById('session-panel'),
            loginForm: document.getElementById('login-form'),
            email: document.getElementById('login-email'),
            password: document.getElementById('login-password'),
            authHint: document.getElementById('auth-hint'),
            sessionName: document.getElementById('session-name'),
            sessionCompany: document.getElementById('session-company'),
            logoutBtn: document.getElementById('logout-btn'),
            catalog: document.getElementById('catalog-grid'),
            cartList: document.getElementById('cart-list'),
            cartCount: document.getElementById('cart-count'),
            cartTotal: document.getElementById('cart-total'),
            checkoutBtn: document.getElementById('checkout-btn'),
            orderList: document.getElementById('order-list'),
            detailId: document.getElementById('detail-id'),
            detailClient: document.getElementById('detail-client'),
            detailMeta: document.getElementById('detail-meta'),
            detailTimeline: document.getElementById('detail-timeline'),
            detailTracking: document.getElementById('detail-tracking'),
            detailStatus: document.getElementById('detail-status'),
            chatTitle: document.getElementById('chat-title'),
            chatSub: document.getElementById('chat-subtitle'),
            chatThread: document.getElementById('chat-thread'),
            chatInput: document.getElementById('chat-input'),
            chatSend: document.getElementById('chat-send'),
            chatDrawer: document.getElementById('chat-drawer'),
            chatLauncher: document.getElementById('chat-launcher'),
            chatBackdrop: document.getElementById('chat-backdrop'),
            refundBtn: document.getElementById('refund-btn'),
            chatClose: document.getElementById('chat-close'),
            syncLabel: document.getElementById('sync-label'),
            successModal: document.getElementById('success-modal'),
            successOrder: document.getElementById('success-order'),
            successText: document.getElementById('success-text'),
            successClose: document.getElementById('success-close'),
            statusBadge: document.getElementById('status-badge'),
            loginSummary: document.getElementById('login-summary'),
            registerPanel: document.getElementById('register-panel'),
            registerForm: document.getElementById('register-form'),
            registerHint: document.getElementById('register-hint'),
            showRegisterBtn: document.getElementById('show-register-btn'),
            backToLoginBtn: document.getElementById('back-to-login-btn'),
            verificationBanner: document.getElementById('verification-banner'),
            verificationStatusBadge: document.getElementById('verification-status-badge'),
            verificationMessage: document.getElementById('verification-message'),
            metricPoints: document.getElementById('metric-points'),
            metricFavorites: document.getElementById('metric-favorites'),
            metricOntime: document.getElementById('metric-ontime'),
            metricSupport: document.getElementById('metric-support')
        };

        let backend = ensureBackend(config);
        // Session starts null and is populated by /api/session/me in boot().
        // Cart stays in localStorage because it's UI state, not auth.
        let session = null;
        let cart = loadCart(config.segment);
        let ordersState = [];
        let selectedOrderId = null;
        let currentUser = null;
        let preferredAuthPanel = 'register'; // 'register' or 'login' - which panel the user prefers to see
        let checkoutInFlight = false;
        let liveProducts = null; // cached live product data for stock validation

        // Persist selected order so realtime subscription is restored after page refresh
        function persistSelectedOrder() {
            if (selectedOrderId) {
                backend.chats = backend.chats || {};
                backend.chats.lastSelectedOrderId = selectedOrderId;
                saveJSON(BACKEND_KEY, backend);
            }
        }

        function restoreSelectedOrder() {
            const lastId = backend?.chats?.lastSelectedOrderId;
            if (lastId && ordersState.find(o => o.id === lastId)) {
                selectedOrderId = lastId;
            }
        }

        function buildLocalAuthUser(email, name, company) {
            return {
                id: `local-${config.segment}-${email}`,
                email,
                user_metadata: {
                    name,
                    company_name: company || '',
                    segment: config.segment,
                    phone: null,
                    address: null,
                }
            };
        }

        // Convert a server session payload into the in-memory shape the rest
        // of the portal uses. The session comes from /api/session/me or the
        // login/register response — it is server-verified, never client-fabricated.
        function sessionFromServer(serverSession) {
            if (!serverSession) return null;
            return {
                segment: serverSession.segment || config.segment,
                email: serverSession.email || '',
                name: serverSession.name || 'Customer',
                company: serverSession.company || '',
                role: serverSession.role || 'client',
                userId: serverSession.userId || null,
                phone: serverSession.phone || '',
                address: serverSession.address || '',
            };
        }

        function currentUserFromSession() {
            if (!session) return null;
            return {
                id: session.userId || `local-${config.segment}-${session.email}`,
                email: session.email,
                user_metadata: {
                    name: session.name,
                    company_name: session.company || '',
                    segment: session.segment,
                    phone: session.phone || null,
                    address: session.address || null,
                },
            };
        }

        function selectedOrders() {
            return ordersState
                .filter((order) => order.segment === config.segment)
                .sort((a, b) => b.createdAt - a.createdAt);
        }

        function mapRetailPurchaseToOrder(p) {
            return {
                id: p.purchase_number,
                order_number: p.purchase_number,
                dbId: p.id,
                segment: 'b2c',
                createdAt: new Date(p.purchase_date || p.created_at || Date.now()).getTime(),
                updatedAt: new Date(p.updated_at || p.purchase_date || p.created_at || Date.now()).getTime(),
                clientName: p.customer_name || session?.name || 'B2C Customer',
                companyName: '',
                product: p.notes || 'Retail order',
                item: p.notes || 'Retail order',
                qty: p.quantity ? String(p.quantity) : '',
                amount: `$${parseFloat(p.total_amount || 0).toFixed(2)}`,
                paymentStatus: p.payment_status || 'Pending',
                status: p.status || 'Confirmed',
                carrier: p.carrier || 'NinjaVan Retail Express',
                trackingNum: p.tracking_number || 'Pending',
                deliveryDate: p.delivery_date || 'Pending',
                deliveredDate: p.delivered_date || 'Pending',
                staffName: '',
                staffRole: '',
                // Fulfillment linkage so RMA can reference the originating fulfillment row(s).
                // These come from the source retail_purchases row; if the checkout flow already
                // synced to fulfillment_orders, fulfillment_order_id will be FUL-{purchase_number}.
                fulfillment_order_id: p.fulfillment_order_id || `FUL-${p.purchase_number}`,
                fulfillment_record_ids: Array.isArray(p.fulfillment_record_ids) ? p.fulfillment_record_ids : [],
                batch_ids: Array.isArray(p.batch_ids) ? p.batch_ids : [],
                // Item-level breakdown (best-effort from notes/items_json columns)
                cartItems: parseItemsFromNotes(p.items_json || p.notes),
                refund_pending: p.refund_pending === true,
                rma_number: p.rma_number || null
            };
        }

        function mapWholesaleOrderToOrder(o) {
            return {
                id: o.order_number,
                order_number: o.order_number,
                dbId: o.id,
                segment: 'b2b',
                createdAt: new Date(o.created_at || Date.now()).getTime(),
                updatedAt: new Date(o.updated_at || o.created_at || Date.now()).getTime(),
                clientName: o.customer_name || session?.name || 'Wholesale Customer',
                companyName: o.company_name || session?.company || '',
                product: o.notes || 'B2B Order',
                item: o.notes || 'B2B Order',
                qty: o.quantity ? String(o.quantity) : '',
                amount: `$${parseFloat(o.total_amount || 0).toFixed(2)}`,
                paymentStatus: o.payment_status || 'Pending approval',
                status: o.status || 'Confirmed',
                carrier: o.carrier || 'NinjaVan Express B2B',
                trackingNum: o.tracking_number || 'Pending',
                deliveryDate: o.delivery_date || 'Pending',
                deliveredDate: o.delivered_date || 'Pending',
                staffName: o.staff_name || '',
                staffRole: o.staff_role || '',
                fulfillment_order_id: o.fulfillment_order_id || `FUL-${o.order_number}`,
                fulfillment_record_ids: Array.isArray(o.fulfillment_record_ids) ? o.fulfillment_record_ids : [],
                batch_ids: Array.isArray(o.batch_ids) ? o.batch_ids : [],
                cartItems: parseItemsFromNotes(o.items_json || o.notes),
                refund_pending: o.refund_pending === true,
                rma_number: o.rma_number || null
            };
        }

        // Parse a stored items_json blob or fallback pipe-separated "N x ProductA" notes
        // into a structured list the refund flow can serialize into an RMA.
        function parseItemsFromNotes(raw) {
            if (!raw) return [];
            try {
                if (typeof raw === 'string' && raw.trim().startsWith('[')) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        return parsed.map(it => ({
                            id: it.item_code || it.id || it.product_code || null,
                            product_code: it.item_code || it.product_code || null,
                            name: it.item_name || it.name || it.product_name || 'Item',
                            qty: Number(it.qty || it.quantity || 1),
                            price: Number(it.unit_price || it.price || it.selling_price || 0)
                        }));
                    }
                }
                if (typeof raw === 'string') {
                    return raw
                        .split('|')
                        .map(part => part.trim())
                        .filter(Boolean)
                        .map(part => {
                            const m = part.match(/^(\d+)\s*[xX×]\s*(.+)$/);
                            return m
                                ? { id: null, product_code: null, name: m[2].trim(), qty: parseInt(m[1]) || 1, price: 0 }
                                : { id: null, product_code: null, name: part, qty: 1, price: 0 };
                        });
                }
            } catch (_) { /* fall through */ }
            return [];
        }

        async function loadProductsFromSupabase() {
            try {
                // Determine category filter based on segment
                // For B2C: category=finished_good (retail catalog)
                // For B2B: category=finished_good (wholesale catalog)
                const categoryFilter = 'finished_good';
                
                // Try direct Supabase client query first (uses anon key + user session)
                let products = [];
                const { data, error } = await supabaseClient
                    .from('inventory')
                    .select('id, item_code, name, unit_cost, selling_price, wholesale_price, category, description, current_stock')
                    .eq('category', categoryFilter)
                    .eq('is_active', true);
                
                if (!error && data && data.length > 0) {
                    products = data;
                } else {
                    // Fallback to local proxy helper
                    const apiProducts = await supabaseAPI({
                        table: 'inventory',
                        operation: 'select',
                        filters: { eq: { category: categoryFilter, is_active: true } },
                        columns: 'id, item_code, name, unit_cost, selling_price, wholesale_price, category, description, current_stock'
                    });
                    if (apiProducts && apiProducts.length > 0) {
                        products = apiProducts;
                    }
                }
                
                liveProducts = products.length > 0 ? products : null;
                return liveProducts;
            } catch (err) {
                return null;
            }
        }

        async function loadOrdersFromSupabase() {
            try {
                const sessionEmail = String(session?.email || '').trim().toLowerCase();
                if (!sessionEmail) {
                    ordersState = [];
                    selectedOrderId = null;
                    return;
                }

                let loadedOrders = [];

                if (config.segment === 'b2c') {
                    let data = [];
                    let query = supabaseClient
                        .from('retail_purchases')
                        .select('*')
                        .eq('customer_email', sessionEmail)
                        .order('purchase_date', { ascending: false });
                    const { data: directData, error } = await query;

                    if (!error && Array.isArray(directData)) {
                        data = directData;
                    } else {
                        data = await supabaseAPI({
                            table: 'retail_purchases',
                            operation: 'select',
                            filters: { eq: { segment: 'b2c', customer_email: sessionEmail } }
                        });
                    }

                    loadedOrders = Array.isArray(data) ? data.map(mapRetailPurchaseToOrder) : [];
                } else {
                    let data = [];
                    let query = supabaseClient
                        .from('orders')
                        .select('*')
                        .eq('segment', 'b2b')
                        .eq('customer_email', sessionEmail)
                        .order('created_at', { ascending: false });
                    const { data: directData, error } = await query;

                    if (!error && Array.isArray(directData)) {
                        data = directData;
                    } else {
                        data = await supabaseAPI({
                            table: 'orders',
                            operation: 'select',
                            filters: { eq: { segment: 'b2b', customer_email: sessionEmail } }
                        });
                    }

                    loadedOrders = Array.isArray(data) ? data.map(mapWholesaleOrderToOrder) : [];
                }

                ordersState = loadedOrders;
                if (!selectedOrderId || !ordersState.some((order) => order.id === selectedOrderId)) {
                    selectedOrderId = ordersState[0] ? ordersState[0].id : null;
                }
            } catch (err) {
                console.warn('Error loading orders from API:', err);
                ordersState = [];
            }
        }

        function persistBackend() {
            backend.lastSyncAt = Date.now();
            saveJSON(BACKEND_KEY, backend);
            mirrorLegacyOrders(backend);
        }

        function enableSessionControls(isLoggedIn) {
            document.querySelectorAll('[data-requires-session="true"]').forEach((node) => {
                node.disabled = !isLoggedIn;
                node.classList.toggle('opacity-50', !isLoggedIn);
            });
        }

        function setChatDrawerOpen(isOpen) {
            els.chatDrawer.classList.toggle('opacity-0', !isOpen);
            els.chatDrawer.classList.toggle('translate-y-4', !isOpen);
            els.chatDrawer.classList.toggle('pointer-events-none', !isOpen);
            els.chatBackdrop.classList.toggle('hidden', !isOpen);
            els.chatLauncher.setAttribute('aria-expanded', String(isOpen));
        }

        function renderAuth() {
            const isLoggedIn = Boolean(session && session.segment === config.segment);
            els.sessionPanel.classList.toggle('hidden', !isLoggedIn);
            enableSessionControls(isLoggedIn);

            if (isLoggedIn) {
                if (els.authPanel) els.authPanel.classList.add('hidden');
                if (els.loginPanel) els.loginPanel.classList.add('hidden');
                els.sessionName.textContent = session.name;
                els.sessionCompany.textContent = session.company;
                // Status badge reflects verification state for B2B
                if (els.statusBadge) {
                    if (config.segment === 'b2b' && currentVerificationStatus === 'pending') {
                        els.statusBadge.textContent = 'Pending Verification';
                        els.statusBadge.className = 'px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-300';
                    } else if (config.segment === 'b2b' && currentVerificationStatus === 'rejected') {
                        els.statusBadge.textContent = 'Rejected';
                        els.statusBadge.className = 'px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-red-100 text-red-800 border border-red-300';
                    } else {
                        els.statusBadge.textContent = 'Logged in';
                        els.statusBadge.className = 'px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider bg-[#ffffff] text-[#6b4423] border border-[#d4a574]/25';
                    }
                }
                els.loginSummary.textContent = `${session.email} is active in ${config.chat?.threadLabel || 'chat'}.`;
            } else {
                // Show auth panels based on user preference
                if (preferredAuthPanel === 'login') {
                    if (els.authPanel) els.authPanel.classList.add('hidden');
                    if (els.loginPanel) els.loginPanel.classList.remove('hidden');
                } else {
                    // Default: show registration panel
                    if (els.authPanel) els.authPanel.classList.remove('hidden');
                    if (els.loginPanel) els.loginPanel.classList.add('hidden');
                }
                setChatDrawerOpen(false);
            }
        }

        function showRegisterPanel() {
            preferredAuthPanel = 'register';
            if (els.loginPanel) els.loginPanel.classList.add('hidden');
            if (els.authPanel) els.authPanel.classList.remove('hidden');
        }

        function showLoginPanel() {
            preferredAuthPanel = 'login';
            if (els.authPanel) els.authPanel.classList.add('hidden');
            if (els.loginPanel) els.loginPanel.classList.remove('hidden');
        }

        async function handleRegister(event) {
            event.preventDefault();
            if (!els.registerForm) return;

            const name = document.getElementById('register-name')?.value.trim();
            const email = document.getElementById('register-email')?.value.trim().toLowerCase();
            const password = document.getElementById('register-password')?.value;
            const company = document.getElementById('register-company')?.value.trim();
            const phone = document.getElementById('register-phone')?.value.trim() || null;
            const address = document.getElementById('register-address')?.value.trim() || null;

            if (!name || !email || !password) {
                els.registerHint.textContent = 'Please fill in all required fields.';
                return;
            }

            if (password.length < 6) {
                els.registerHint.textContent = 'Password must be at least 6 characters.';
                return;
            }

            els.registerHint.textContent = 'Creating account...';
            els.registerHint.classList.remove('text-green-600', 'text-red-600');

            let serverSession = null;
            try {
                serverSession = await registerViaServer({
                    email,
                    password,
                    name,
                    company,
                    segment: config.segment,
                    phone,
                    address,
                });
            } catch (err) {
                els.registerHint.textContent = err.message || 'Unable to create account.';
                els.registerHint.classList.add('text-red-600');
                return;
            }

            els.registerHint.textContent = 'Account created.';
            els.registerHint.classList.add('text-green-600');

            await loginWithSession(serverSession);
        }

        async function loginWithSession(serverSession) {
            session = sessionFromServer(serverSession);
            currentUser = currentUserFromSession();
            if (!session) {
                renderAuth();
                return;
            }

            if (config.segment === 'b2c') {
                currentVerificationStatus = 'approved';
                await applyVerificationState('approved');
                renderAuth();
                syncOrdersFromBackend();
                syncCustomerToDatabase(session)
                    .then(() => syncOrdersFromBackend())
                    .catch((err) => console.warn('B2C customer sync will retry on next session activity:', err));
                return;
            }

            // Create or update customer profile row (idempotent — server checks for existing email).
            await syncCustomerToDatabase(session);

            // Check B2B verification status
            const verStatus = await checkVerificationStatus(session.email);
            await applyVerificationState(verStatus);

            renderAuth();
            syncOrdersFromBackend();
        }

        async function syncCustomerToDatabase(customerSession) {
            try {
                if (config.segment === 'b2c') {
                    const existing = await supabaseAPI({
                        table: 'retail_buyers',
                        operation: 'select',
                        filters: { eq: { email: customerSession.email } }
                    });

                    if (!existing || existing.length === 0) {
                        await supabaseAPI({
                            table: 'retail_buyers',
                            operation: 'insert',
                            data: {
                                email: customerSession.email,
                                name: customerSession.name,
                                phone: customerSession.phone || null,
                                address: customerSession.address || null,
                            },
                            returning: '*'
                        });
                    }
                } else {
                    const existing =                 await supabaseAPI({
                    table: 'customer_accounts',
                    operation: 'select',
                    filters: { eq: { email: customerSession.email } }
                });

                if (!existing || existing.length === 0) {
                    await supabaseAPI({
                        table: 'customer_accounts',
                            operation: 'insert',
                            data: {
                                email: customerSession.email,
                                name: customerSession.name,
                                company_name: customerSession.company || null,
                                segment: config.segment,
                                is_active: true,
                                verification_status: 'pending',
                                phone: customerSession.phone || null,
                                address: customerSession.address || null,
                            },
                            returning: '*'
                        });
                    }
                }
            } catch (err) {
                console.warn('Error syncing customer to database:', err);
            }
        }

        // Check B2B verification status from the database. Returns one of:
        //   'approved' | 'pending' | 'rejected' | 'unknown'
        // 'unknown' is distinct from 'pending': it means we couldn't reach
        // the database (network error, timeout, 5xx). 'pending' is a real
        // backend state — the row exists but hasn't been reviewed yet.
        // The UI shows a different banner + retry button for 'unknown' so
        // the user knows to try again rather than waiting for review.
        async function checkVerificationStatus(email, { signal } = {}) {
            if (config.segment !== 'b2b') return 'approved';
            try {
                const records = await supabaseAPI({
                    table: 'customer_accounts',
                    operation: 'select',
                    filters: { eq: { email: email } },
                    ...(signal ? { signal } : {}),
                });
                if (records && records.length > 0) {
                    const raw = records[0].verification_status;
                    return raw || 'pending';
                }
                // No row yet — treat as 'unknown' rather than 'pending' so we
                // don't pretend verification has been queued.
                return 'unknown';
            } catch (err) {
                console.warn('Verification status check failed:', err);
                return 'unknown';
            }
        }

        let currentVerificationStatus = 'unknown';

        async function applyVerificationState(status) {
            currentVerificationStatus = status;
            const banner = els.verificationBanner;
            const badge = els.verificationStatusBadge;
            const msg = els.verificationMessage;

            if (!banner) return;

            const isPending = status === 'pending';
            const isRejected = status === 'rejected';
            const isApproved = status === 'approved';
            const isUnknown = status === 'unknown';

            if (isPending) {
                banner.className = 'relative z-10 px-8 py-4 bg-amber-50 border-b border-amber-200';
                banner.classList.remove('hidden');
                if (badge) {
                    badge.className = 'px-3 py-1 rounded-full bg-amber-200 text-amber-800 text-[10px] font-black uppercase tracking-wider';
                    badge.textContent = 'Pending Review';
                }
                if (msg) msg.textContent = 'Your B2B account is awaiting review by the finance team. You can log in and browse, but cannot place orders until verified.';
            } else if (isRejected) {
                banner.className = 'relative z-10 px-8 py-4 bg-red-50 border-b border-red-200';
                banner.classList.remove('hidden');
                if (badge) {
                    badge.className = 'px-3 py-1 rounded-full bg-red-200 text-red-800 text-[10px] font-black uppercase tracking-wider';
                    badge.textContent = 'Rejected';
                }
                if (msg) msg.textContent = 'Your B2B application has been rejected. Please contact the finance team for more information.';
            } else if (isUnknown) {
                // Network / DB error — show a neutral banner with a retry
                // affordance so the user doesn't sit forever thinking they
                // have to wait for review.
                banner.className = 'relative z-10 px-8 py-4 bg-slate-50 border-b border-slate-200';
                banner.classList.remove('hidden');
                if (badge) {
                    badge.className = 'px-3 py-1 rounded-full bg-slate-200 text-slate-800 text-[10px] font-black uppercase tracking-wider';
                    badge.textContent = 'Status Unavailable';
                }
                if (msg) msg.textContent = "We couldn't reach the verification service. Some features may be unavailable until it's back. Click to retry.";
                banner.style.cursor = 'pointer';
                banner.onclick = (e) => {
                    // Don't re-trigger if the click was on a nested control.
                    if (e.target.closest('button')) return;
                    refreshVerificationStatus();
                };
            } else {
                banner.classList.add('hidden');
                banner.onclick = null;
                banner.style.cursor = '';
            }

            // Block cart/checkout unless explicitly approved.
            // 'unknown' blocks too — better safe than sorry. A manual refresh
            // via the banner above can flip it if the service returns.
            const cartBlocked = !isApproved;
            if (els.checkoutBtn) {
                els.checkoutBtn.disabled = cartBlocked;
                els.checkoutBtn.classList.toggle('opacity-50', cartBlocked);
                els.checkoutBtn.classList.toggle('cursor-not-allowed', cartBlocked);
            }
            // Block add-to-cart buttons
            document.querySelectorAll('button[data-product]').forEach(btn => {
                btn.disabled = cartBlocked;
                btn.classList.toggle('opacity-50', cartBlocked);
            });
        }

        async function refreshVerificationStatus() {
            const session = await fetchSessionFromServer();
            if (!session || !session.email) return;
            const status = await checkVerificationStatus(session.email);
            await applyVerificationState(status);
            return status;
        }

        async function checkExistingSession() {
            const serverSession = await fetchSessionFromServer();
            if (!serverSession) return;
            if (serverSession.segment && serverSession.segment !== config.segment) return;
            await loginWithSession(serverSession);
        }

        function renderCatalog(liveProducts) {
            const products = liveProducts && liveProducts.length > 0 ? liveProducts : config.products;
            if (!products || products.length === 0) {
                els.catalog.innerHTML = `
                    <div class="col-span-full text-center py-12 text-neutral-400">
                        <span class="material-symbols-outlined text-5xl">inventory_2</span>
                        <p class="mt-4 text-sm">No products available yet.</p>
                        <p class="text-xs mt-1">Check back soon or contact support.</p>
                    </div>
                `;
                return;
            }
            els.catalog.innerHTML = products.map((product) => {
                // Map database fields to display fields
                const displayProduct = {
                    id: product.id || product.item_code || product.product_code,
                    product_code: product.item_code || product.product_code || product.id,
                    name: product.name || 'Unknown Product',
                    price: config.segment === 'b2c'
                        ? (Number(product.selling_price) || Number(product.unit_cost) || 0)
                        : (Number(product.wholesale_price) || Number(product.unit_cost) || 0),
                    description: product.description || product.desc || '',
                    tag: product.tag || (product.category === 'finished_good' ? 'Retail' : product.category === 'raw_material' ? 'Wholesale' : ''),
                    current_stock: Number(product.current_stock) || 0
                };
                const isOutOfStock = displayProduct.current_stock === 0;
                const lowStock = displayProduct.current_stock > 0 && displayProduct.current_stock <= 5;
                const articleClass = isOutOfStock
                    ? 'rounded-2xl border border-white/5 bg-neutral-900/30 p-5 shadow-sm opacity-50 pointer-events-none'
                    : 'rounded-2xl border border-white/10 bg-neutral-900/60 p-5 shadow-sm hover:border-white/30 transition-all duration-300';
                const buttonClass = isOutOfStock
                    ? 'mt-4 w-full px-4 py-3 rounded-xl bg-neutral-700 text-neutral-400 text-xs font-bold uppercase tracking-widest cursor-not-allowed'
                    : 'mt-4 w-full px-4 py-3 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-bold uppercase tracking-widest transition-all active:scale-95';
                const buttonText = isOutOfStock ? 'Out of Stock' : 'Add to cart';
                return `
                <article class="${articleClass}">
                    <div class="flex items-start justify-between gap-3">
                        <div>
                            <div class="text-[10px] uppercase tracking-widest text-neutral-400 font-extrabold">${displayProduct.tag || ''}</div>
                            <h3 class="text-base font-bold text-white mt-1">${displayProduct.name}</h3>
                        </div>
                        <div class="px-2.5 py-1 rounded-full bg-neutral-950 border border-white/10 text-[10px] font-black text-neutral-300">${money(displayProduct.price)}</div>
                    </div>
                    <p class="text-xs text-neutral-400 font-light mt-3 leading-relaxed">${displayProduct.description || ''}</p>
                    ${isOutOfStock ? `<p class="text-[10px] text-red-400 font-bold mt-2">Out of stock — check back later</p>` : ''}
                    ${lowStock ? `<p class="text-[10px] text-amber-400 font-bold mt-2">Only ${displayProduct.current_stock} left</p>` : ''}
                    <button data-product="${displayProduct.product_code || displayProduct.id}" class="${buttonClass}" ${isOutOfStock ? 'disabled' : ''}>
                        ${buttonText}
                    </button>
                </article>
            `}).join('');

            els.catalog.querySelectorAll('button[data-product]').forEach((button) => {
                button.addEventListener('click', () => {
                    // Find product - handle both database format (item_code) and config format (product_code)
                    const product = products.find((item) => (item.item_code || item.product_code || item.id) === button.dataset.product);
                    if (!product) return;

                    const currentStock = Number(product.current_stock) || 0;

                    // Block adding out-of-stock items
                    if (currentStock === 0) {
                        return;
                    }

                    // Normalize product fields for cart
                    const normalizedProduct = {
                        id: product.item_code || product.product_code || product.id,
                        product_code: product.item_code || product.product_code || product.id,
                        name: product.name || 'Unknown Product',
                        price: config.segment === 'b2c'
                            ? (Number(product.selling_price) || Number(product.unit_cost) || 0)
                            : (Number(product.wholesale_price) || Number(product.unit_cost) || 0),
                        description: product.description || product.desc || '',
                        category: product.category,
                        current_stock: currentStock
                    };

                    const existing = cart.find((item) => (item.product_code || item.id) === (normalizedProduct.product_code || normalizedProduct.id));

                    if (existing) {
                        // Only increase if it won't exceed available stock
                        const totalAfterAdd = existing.qty + 1;
                        if (totalAfterAdd > currentStock) {
                            // Refresh stock from latest product data
                            const latestProduct = products.find((p) => (p.item_code || p.product_code || p.id) === existing.product_code);
                            const latestStock = latestProduct ? (Number(latestProduct.current_stock) || 0) : existing.current_stock;
                            if (totalAfterAdd > latestStock) {
                                alert(`Only ${latestStock} unit${latestStock === 1 ? '' : 's'} available in stock for ${normalizedProduct.name}.`);
                                return;
                            }
                            existing.current_stock = latestStock;
                        }
                        existing.qty += 1;
                    } else {
                        // Enforce single-add cap for items with stock of 1
                        if (currentStock < 1) {
                            alert(`Sorry, ${normalizedProduct.name} is out of stock.`);
                            return;
                        }
                        cart.push({ ...normalizedProduct, qty: 1 });
                    }
                    saveCart(config.segment, cart);
                    renderCart();
                });
            });
        }

    function removeFromCart(itemId) {
        cart = cart.filter((item) => item.id !== itemId);
        saveCart(config.segment, cart);
        renderCart();
    }

    function changeQty(itemId, delta, liveProducts) {
        const item = cart.find((i) => i.id === itemId);
        if (!item) return;

        // Use latest stock from products if available, fall back to stored stock
        let availableStock = item.current_stock || 0;
        if (liveProducts) {
            const liveProduct = liveProducts.find((p) => (p.item_code || p.product_code || p.id) === item.product_code || (p.item_code || p.product_code || p.id) === item.id);
            if (liveProduct) {
                availableStock = Number(liveProduct.current_stock) || 0;
                item.current_stock = availableStock; // refresh stored stock
            }
        }

        const newQty = item.qty + delta;
        if (delta > 0 && newQty > availableStock) {
            alert(`Only ${availableStock} unit${availableStock === 1 ? '' : 's'} available for ${item.name}.`);
            return;
        }
        if (newQty < 1) {
            removeFromCart(itemId);
            return;
        }

        item.qty = newQty;
        saveCart(config.segment, cart);
        renderCart();
    }

    function renderCart() {
        const total = cart.reduce((sum, item) => sum + item.qty * item.price, 0);
        const count = cart.reduce((sum, item) => sum + item.qty, 0);

        els.cartCount.textContent = `${count} item${count === 1 ? '' : 's'}`;
        els.cartTotal.textContent = money(total);
        els.checkoutBtn.disabled = !session || session.segment !== config.segment || count === 0;

        els.cartList.innerHTML = cart.length ? cart.map((item) => {
                let availableStock = item.current_stock || 0;
                if (liveProducts) {
                    const lp = liveProducts.find((p) => (p.item_code || p.product_code || p.id) === item.product_code || (p.item_code || p.product_code || p.id) === item.id);
                    if (lp) availableStock = Number(lp.current_stock) || 0;
                }
                const atStockLimit = availableStock > 0 && item.qty >= availableStock;
                const lowStock = availableStock > 0 && availableStock <= 5 && !atStockLimit;
                return `
                <div class="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-neutral-950/60 p-3">
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-bold text-white truncate">${item.name}</div>
                        <div class="text-[10px] uppercase tracking-wider text-neutral-400 font-black">Qty ${item.qty}${availableStock > 0 ? ` / ${availableStock} available` : ''}</div>
                        ${lowStock ? `<div class="text-[10px] text-amber-400 font-bold">Only ${availableStock} left</div>` : ''}
                        ${atStockLimit ? `<div class="text-[10px] text-red-400 font-bold">Max stock reached</div>` : ''}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <div class="text-xs font-bold text-white">${money(item.price * item.qty)}</div>
                        <div class="flex items-center gap-1">
                            <button data-qty-dec="${item.id}" class="w-6 h-6 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white text-xs font-bold flex items-center justify-center transition-colors" title="Decrease">−</button>
                            <button data-qty-inc="${item.id}" class="w-6 h-6 rounded-lg ${atStockLimit ? 'bg-neutral-800 text-neutral-600 cursor-not-allowed' : 'bg-neutral-800 hover:bg-neutral-700 text-white'} text-xs font-bold flex items-center justify-center transition-colors" title="${atStockLimit ? 'Max stock reached' : 'Increase'}">+</button>
                            <button data-cart-remove="${item.id}" class="w-6 h-6 rounded-lg bg-red-900/50 hover:bg-red-800 text-red-300 text-xs font-bold flex items-center justify-center transition-colors" title="Remove">✕</button>
                        </div>
                    </div>
                </div>
            `}).join('') : '<div class="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs font-semibold text-neutral-500">Your cart is empty.</div>';

        // Bind cart item controls
        els.cartList.querySelectorAll('button[data-qty-dec]').forEach((btn) => {
            btn.addEventListener('click', () => changeQty(btn.dataset.qtyDec, -1, liveProducts));
        });
        els.cartList.querySelectorAll('button[data-qty-inc]').forEach((btn) => {
            btn.addEventListener('click', () => changeQty(btn.dataset.qtyInc, 1, liveProducts));
        });
        els.cartList.querySelectorAll('button[data-cart-remove]').forEach((btn) => {
            btn.addEventListener('click', () => removeFromCart(btn.dataset.cartRemove));
        });
    }

        function renderOrders() {
            const orders = selectedOrders();
            if (!selectedOrderId || !orders.some((order) => order.id === selectedOrderId)) {
                selectedOrderId = orders[0] ? orders[0].id : null;
            }

            els.orderList.innerHTML = orders.map((order) => `
                <button class="w-full text-left rounded-2xl border p-4 transition-all duration-300 ${order.id === selectedOrderId ? 'border-white bg-white text-black' : 'border-white/10 bg-neutral-900/40 text-white hover:border-white/30'}" data-order="${order.id}">
                    <div class="flex items-center justify-between gap-3">
                        <div>
                            <div class="text-[10px] uppercase tracking-widest font-black ${order.id === selectedOrderId ? 'text-black/70' : 'text-neutral-400'}">${order.id}</div>
                            <div class="font-bold mt-1">${order.clientName}</div>
                        </div>
                        <span class="px-2 py-1 rounded-full text-[9px] font-black uppercase tracking-wider ${order.id === selectedOrderId ? 'bg-neutral-200 text-black border border-white/10' : 'bg-neutral-800 text-neutral-300'}">
                            ${order.status}
                        </span>
                    </div>
                    <div class="text-xs opacity-85 font-light mt-3 leading-relaxed">${order.product}</div>
                </button>
            `).join('');

            els.orderList.querySelectorAll('button[data-order]').forEach((button) => {
                button.addEventListener('click', () => {
                    selectedOrderId = button.dataset.order;
                    persistSelectedOrder();
                    renderOrders();
                    renderDetail();
                    const order = ordersState.find((item) => item.id === selectedOrderId);
                    initRealtimeThread(order);
                    renderChat();
                });
            });

            renderDetail();
            const initOrder = ordersState.find((item) => item.id === selectedOrderId);
            initRealtimeThread(initOrder);
            renderChat();
        }

        function renderDetail() {
            const order = ordersState.find((item) => item.id === selectedOrderId);
            if (!order) {
                els.detailId.textContent = 'No order selected';
                els.detailClient.textContent = 'Log in and check out to create your first order.';
                els.detailMeta.textContent = '';
                els.detailTracking.textContent = '';
                els.detailStatus.textContent = '';
                els.detailTimeline.innerHTML = '';
                return;
            }

            els.detailId.textContent = order.id;
            els.detailClient.textContent = order.clientName;
            els.detailMeta.textContent = `${order.companyName} · ${order.product} · ${order.qty}`;
            els.detailTracking.textContent = order.trackingNum;
            els.detailStatus.textContent = order.status;
            els.detailTimeline.innerHTML = renderTimeline(order);
            
            if (els.refundBtn) {
                // Refund flow removed. The button stays in the UI so the order
                // detail layout doesn't reflow, but it's disabled and points users
                // to the support chat for any refund conversation. Historical RMA
                // state from before this change still renders via the order badge.
                els.refundBtn.classList.remove('hidden');
                els.refundBtn.textContent = 'Refunds via support';
                els.refundBtn.disabled = true;
                els.refundBtn.classList.add('opacity-50');
            }
            
            // Update chat header with order context
            const segmentLabel = config.segment === 'b2b' ? 'Wholesale' : 'Retail';
            const segmentIcon = config.segment === 'b2b' ? 'business' : 'person';
            els.chatTitle.textContent = `${segmentLabel} Support`;
            els.chatSub.textContent = `${config.staff.name} · ${config.staff.role} · ${order.id}`;
            els.chatInput.placeholder = config.chat?.placeholder || 'Message about your order...';
            
            // Update chat drawer header with order badge
            updateChatHeader(order, config);
        }
        
        function updateChatHeader(orderParam, configParam) {
            const order = orderParam || (ordersState.find((item) => item.id === selectedOrderId));
            const config = configParam || window.PORTAL_CONFIG || { staff: { name: 'Support', role: 'Agent' }, segment: config.segment };
            const headerEl = document.getElementById('chat-header-content');
            if (headerEl) {
                const statusColor = {
                    'Confirmed': 'bg-blue-500/20 text-blue-300',
                    'Processing': 'bg-yellow-500/20 text-yellow-300',
                    'Packed': 'bg-orange-500/20 text-orange-300',
                    'Shipped': 'bg-purple-500/20 text-purple-300',
                    'Delivered': 'bg-green-500/20 text-green-300',
                    'Refund Requested': 'bg-red-500/20 text-red-300',
                    'Refunded': 'bg-gray-500/20 text-gray-300',
                    'Cancelled': 'bg-gray-500/20 text-gray-300'
                }[order?.status] || 'bg-neutral-500/20 text-neutral-300';

                headerEl.innerHTML = `
                    <div class="flex items-center justify-between mb-3 pb-3 border-b border-white/10">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
                                <span class="material-symbols-outlined text-white/70">${config.segment === 'b2b' ? 'business' : 'person'}</span>
                            </div>
                            <div>
                                <div class="text-sm font-bold text-white">${config.staff?.name || 'Support'}</div>
                                <div class="text-[10px] text-white/50">${config.staff?.role || 'Agent'}</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="px-2 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider ${statusColor}">
                                ${order?.status || 'Unknown'}
                            </span>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 text-[10px] text-white/40 mb-2">
                        <span class="material-symbols-outlined text-xs">receipt_long</span>
                        <span>Order: ${order?.id || '—'}</span>
                        <span class="mx-1">·</span>
                        <span class="material-symbols-outlined text-xs">local_shipping</span>
                        <span>${order?.trackingNum || 'Pending'}</span>
                    </div>
                `;
            }
        }

        // Realtime chat variables
        let realtimeChats = [];
        let currentThreadId = null;
        let currentChannelId = null;
        let activeChannel = null;
        let lastChatOrderId = null;
        let realtimeUnsubscribe = null;
        let chatPollTimer = null;

        // ── Chat polling fallback ─────────────────────────────────────────────
        // Supabase Realtime may not always deliver INSERT events (free-tier
        // limits, publication not enabled, network glitch). This lightweight
        // poller runs every 5 s while a chat channel is open and merges any
        // server-side messages the client hasn't seen yet (e.g. AI auto-replies
        // or staff messages sent from the Support Hub).
        function startChatPolling() {
            stopChatPolling();
            chatPollTimer = setInterval(async () => {
                if (!currentChannelId) return;
                try {
                    const msgs = await supabaseAPI({
                        table: 'chat_messages',
                        operation: 'select',
                        filters: { eq: { channel_id: currentChannelId } }
                    });
                    if (!msgs || msgs.length === 0) return;
                    const existingIds = new Set(realtimeChats.map((m) => m.id));
                    let added = false;
                    for (const msg of msgs) {
                        if (!existingIds.has(msg.id)) {
                            realtimeChats.push(msg);
                            added = true;
                        }
                    }
                    if (added) {
                        realtimeChats.sort((a, b) =>
                            (a.created_at ? new Date(a.created_at) : 0) -
                            (b.created_at ? new Date(b.created_at) : 0)
                        );
                        renderChat();
                    }
                } catch (err) {
                    // Polling failures are non-fatal — the next tick will retry.
                    console.debug('[chat-poll] error:', err?.message || err);
                }
            }, 5000);
        }

        function stopChatPolling() {
            if (chatPollTimer) {
                clearInterval(chatPollTimer);
                chatPollTimer = null;
            }
        }

        function unsubscribeRealtime() {
            stopChatPolling();
            if (realtimeUnsubscribe) {
                realtimeUnsubscribe();
                realtimeUnsubscribe = null;
            }
            if (activeChannel) {
                const chan = activeChannel;
                activeChannel = null;
                try { chan.unsubscribe(); } catch (_) { /* noop */ }
                try { supabaseClient.removeChannel(chan); } catch (_) { /* noop */ }
            }
        }

        // Seed messages shown instantly from local storage while realtime thread loads
        function seedLocalChat(order) {
            const backend = readJSON(BACKEND_KEY, defaultBackend());
            let local = (backend.chats && backend.chats[order.id]) ? backend.chats[order.id] : [];
            if (local.length > 0) {
                local = local.map(normalizeMsg);
                // One-time migration: rewrite old-format cache entries in place
                backend.chats[order.id] = local;
                saveJSON(BACKEND_KEY, backend);
                return local;
            }
            // Return a synthetic seeded thread so UI isn't empty while fetching
            return seedThread(order, config);
        }

        // Normalize legacy message format to the current schema
        function normalizeMsg(msg) {
            return {
                id: msg.id,
                sender_id: msg.sender_id || msg.sender || 'unknown',
                sender_name: msg.sender_name || msg.name || 'Unknown',
                message_text: msg.message_text || msg.text || msg.content || '',
                created_at: msg.created_at
                    ? (typeof msg.created_at === 'number' ? new Date(msg.created_at).toISOString() : msg.created_at)
                    : (msg.at ? new Date(msg.at).toISOString() : new Date().toISOString()),
                is_system: msg.is_system || msg.sender_id === 'system' || msg.sender === 'system' || false,
                is_staff: msg.is_staff || msg.sender_id === 'staff' || msg.sender === 'staff' || false,
                is_customer: msg.is_customer || msg.sender_id === 'customer' || msg.sender === 'customer' || false
            };
        }

        async function initRealtimeThread(order) {
            if (!order || !order.id) return;
            if (lastChatOrderId === order.id && currentChannelId) return; // Already initialized for this order

            lastChatOrderId = order.id;
            unsubscribeRealtime();
            realtimeChats = seedLocalChat(order); // show local seed immediately
            currentThreadId = null;
            currentChannelId = null;

            try {
                // Use upsert to avoid duplicate channels — race-safe with the unique index on order_id
                let threadData = await supabaseAPI({
                    table: 'chat_channels',
                    operation: 'upsert',
                    data: {
                        order_id: order.id,
                        channel_type: config.segment === 'b2b' ? 'b2b_customer' : 'b2c_customer',
                        channel_name: `Order ${order.id.slice(0, 8)}`,
                        customer_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(currentUser?.id || '') ? currentUser.id : null,
                        customer_email: session?.email || currentUser?.email || null,
                        customer_segment: config.segment,
                        created_by: 'customer',
                        is_active: true,
                        is_resolved: false
                    },
                    onConflict: 'order_id'
                });

                if (!threadData || threadData.length === 0) return;
                const threadChannel = Array.isArray(threadData) ? threadData[0] : threadData;
                currentThreadId = threadChannel.id;
                currentChannelId = threadChannel.id;

                const msgs = await supabaseAPI({
                    table: 'chat_messages',
                    operation: 'select',
                    filters: { eq: { channel_id: currentChannelId } }
                });
                realtimeChats = (msgs && msgs.length > 0) ? msgs : realtimeChats;

                if (realtimeChats.length === 0 || (realtimeChats.length === 1 && realtimeChats[0].sender_id === 'system')) {
                    await supabaseAPI({
                        table: 'chat_messages',
                        operation: 'insert',
                        data: {
                            channel_id: currentChannelId,
                            thread_id: currentChannelId,
                            sender_id: 'system',
                            sender_name: 'Backend Sync',
                            sender_role: 'system',
                            is_staff: false,
                            is_customer: false,
                            is_system: true,
                            message_type: 'system',
                            message_text: `System: Order ${order.id} thread started.`
                        }
                    });
                    realtimeChats = [{
                        channel_id: currentChannelId,
                        thread_id: currentChannelId,
                        sender_id: 'system',
                        sender_name: 'Backend Sync',
                        sender_role: 'system',
                        is_staff: false,
                        is_customer: false,
                        is_system: true,
                        message_type: 'system',
                        message_text: `System: Order ${order.id} thread started.`
                    }];
                }

                // Render chat with loaded messages
                renderChat();

                // Set up Supabase Realtime subscription for this channel
                if (currentChannelId) {
                    const channelName = `chat-${currentChannelId}`;
                    // Remove any stale channel with the same name before re-subscribing
                    try {
                        const stale = supabaseClient.channel(channelName);
                        if (stale) {
                            stale.unsubscribe();
                            supabaseClient.removeChannel(stale);
                        }
                    } catch (_) { /* noop */ }

                    activeChannel = supabaseClient
                        .channel(channelName)
                        .on(
                            'postgres_changes',
                            {
                                event: 'INSERT',
                                schema: 'public',
                                table: 'chat_messages',
                                filter: `channel_id=eq.${currentChannelId}`
                            },
                            (payload) => {
                                const msg = payload.new;
                                // Avoid duplicates (our own sends are already in local array)
                                if (!realtimeChats.find((m) => m.id === msg.id)) {
                                    realtimeChats.push(msg);
                                    // Re-sort by created_at timestamp
                                    realtimeChats.sort((a, b) =>
                                        (a.created_at ? new Date(a.created_at) : 0) -
                                        (b.created_at ? new Date(b.created_at) : 0)
                                    );
                                    renderChat(); // Re-render only the chat content
                                }
                            }
                        )
                        .subscribe((status) => {
                            // Supabase Realtime channel status
                            if (status === 'SUBSCRIBED') {
                                renderChat(); // Refresh chat when subscription is established
                            }
                        }, (err) => {
                            // Handle subscribe errors gracefully (e.g. channel already subscribed)
                            console.warn('Realtime subscribe error:', err?.message || err);
                        });
                }

                // Start polling fallback — guarantees new messages appear even
                // if Supabase Realtime is unavailable or delayed.
                startChatPolling();
            } catch (err) {
                console.warn('Error initializing realtime thread:', err);
            }
        }

        async function renderChat() {
            const order = ordersState.find((item) => item.id === selectedOrderId);
            if (!order) {
                lastChatOrderId = null;
                els.chatThread.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 p-4 text-xs font-semibold text-neutral-500">${config.chat?.emptyState || 'Select an order to open chat.'}</div>`;
                updateChatHeader(null, config);
                return;
            }

            // Kick off realtime thread init in background (calls renderChat when done)
            initRealtimeThread(order);

            if (!Array.isArray(realtimeChats) || realtimeChats.length === 0) {
                els.chatThread.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 p-4 text-xs font-semibold text-neutral-500">Loading live chat...</div>`;
                updateChatHeader(order, config);
                return;
            }

            els.chatThread.innerHTML = realtimeChats.map((message) => {
                const msg = normalizeMsg(message);
                const isCustomerMsg = msg.sender_id === 'customer' || (session && msg.sender_name === session.name);
                const isSystemMsg = msg.sender_id === 'system' || msg.sender_id === 'Refund Gateway';
                const isStaffMsg = msg.sender_id === 'staff';
                
                let bubbleClass = 'bg-neutral-800 text-neutral-200 rounded-2xl rounded-tl-sm border border-white/5 shadow-md';
                let containerClass = 'justify-start';
                
                if (isSystemMsg) {
                    return `
                        <div class="flex justify-center mb-3">
                            <div class="bg-neutral-800/50 text-neutral-400 text-[10px] px-3 py-1.5 rounded-full border border-white/5">
                                <span class="material-symbols-outlined text-xs mr-1">info</span>
                                ${msg.message_text}
                            </div>
                        </div>
                    `;
                } else if (isCustomerMsg) {
                    bubbleClass = msg._pending === 'failed'
                        ? 'bg-red-50 text-red-900 border border-red-300 rounded-2xl rounded-tr-sm'
                        : 'bg-white text-black rounded-2xl rounded-tr-sm';
                    containerClass = 'justify-end';
                } else if (isStaffMsg) {
                    bubbleClass = 'bg-amber-100 text-black rounded-2xl rounded-tl-sm border border-amber-200';
                }

                const failedFooter = (isCustomerMsg && msg._pending === 'failed') ? `
                    <div class="mt-1 flex items-center gap-2 justify-end">
                        <span class="text-[9px] text-red-700 font-bold uppercase tracking-wider">Not delivered</span>
                        <button type="button" class="text-[9px] font-bold uppercase tracking-wider text-red-700 underline" data-retry-chat="${msg.id || ''}">Retry</button>
                    </div>
                ` : '';

                const pendingDot = (isCustomerMsg && msg._pending === true) ? `
                    <span class="text-[9px] text-white/40" title="Sending…">⏳</span>
                ` : '';

                return `
                    <div class="flex ${containerClass} mb-3">
                        <div class="max-w-[85%]">
                            <div class="flex items-baseline gap-2 mb-1 ${isCustomerMsg ? 'flex-row-reverse' : ''}">
                                <span class="text-[10px] font-bold ${isCustomerMsg ? 'text-white/70' : isStaffMsg ? 'text-black' : 'text-white/70'}">${msg.sender_name || 'System'}</span>
                                <span class="text-[9px] text-white/30">${shortDateTime(msg.created_at || Date.now())}</span>
                                ${isStaffMsg ? '<span class="text-[8px] bg-amber-200 text-black px-1.5 py-0.5 rounded-full">Staff</span>' : ''}
                                ${isCustomerMsg ? '<span class="text-[8px] bg-white/20 text-white/70 px-1.5 py-0.5 rounded-full">You</span>' : ''}
                                ${pendingDot}
                            </div>
                            <div class="p-3 text-xs leading-relaxed ${bubbleClass}">
                                ${msg.message_text}
                            </div>
                            ${msg.order_status ? `
                                <div class="mt-1 text-[9px] text-white/40 flex items-center gap-1 ${isCustomerMsg ? 'justify-end' : ''}">
                                    <span class="material-symbols-outlined text-[10px]">local_shipping</span>
                                    Order: ${msg.order_status}
                                </div>
                            ` : ''}
                            ${failedFooter}
                        </div>
                    </div>
                `;
            }).join('');

            // Wire up the inline Retry buttons. We use event delegation so we
            // don't have to re-bind on every render.
            els.chatThread.querySelectorAll('[data-retry-chat]').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const localId = btn.getAttribute('data-retry-chat');
                    if (localId) retryChatMessage(localId);
                });
            });
            
            setTimeout(() => {
                if (els.chatDrawer && !els.chatDrawer.classList.contains('hidden')) {
                    const threadEl = els.chatThread.parentElement;
                    threadEl.scrollTop = threadEl.scrollHeight;
                }
            }, 50);
        }

        function renderMetrics() {
        const segmentOrders = ordersState.filter((o) => o.segment === config.segment);
        if (!els.metricPoints) return;

        // Points: $1 spent = 1 point
        const totalSpent = segmentOrders.reduce((sum, o) => {
            const val = parseFloat(o.amount?.replace('$', '').replace(',', '')) || 0;
            return sum + val;
        }, 0);
        const points = Math.floor(totalSpent);
        els.metricPoints.textContent = points.toLocaleString();

        // Favorites: count unique products ordered
        const productSet = new Set();
        segmentOrders.forEach((o) => {
            if (o.product) o.product.split('|').forEach((p) => productSet.add(p.trim()));
        });
        els.metricFavorites.textContent = productSet.size > 0 ? productSet.size : '--';

        // On-time: orders where status reached "Delivered" within expected window
        const delivered = segmentOrders.filter((o) => o.status === 'Delivered');
        els.metricOntime.textContent = segmentOrders.length > 0
            ? Math.round((delivered.length / segmentOrders.length) * 100) + '%'
            : '--';

        // Support tickets: count of orders with chat messages (approximate)
        const ticketCount = segmentOrders.length;
        els.metricSupport.textContent = ticketCount > 0 ? ticketCount : '--';
    }

    function openSuccess(order) {
            els.successOrder.textContent = order.id;
            els.successText.textContent = `Checked out and saved to the backend system.`;
            els.successModal.classList.remove('hidden');
        }

        function autoReply(order) {
            if (!currentThreadId) return;
            setTimeout(async () => {
                const reply = order.status === 'Delivered'
                    ? `I've confirmed ${order.id}. If you need anything else, I'm here to help.`
                    : `I've logged your note for ${order.id}. The backend currently shows ${order.status.toLowerCase()} status and I'll keep tracking it.`;
                try {
                    await supabaseAPI({
                        table: 'chat_messages',
                        operation: 'insert',
                        data: {
                            channel_id: currentChannelId,
                            thread_id: currentThreadId,
                            sender_id: 'staff',
                            sender_name: config.staff.name,
                            sender_role: 'staff',
                            is_staff: true,
                            is_customer: false,
                            is_system: false,
                            message_type: 'message',
                            message_text: reply
                        }
                    });
                } catch (err) {
                    console.warn('Error sending auto reply:', err);
                }
            }, 900);
        }

        // Fire-and-forget trigger for the server-side AI staff reply.
        // The server enforces the safety gate (refuse-list / cooldown / daily
        // cap / dedupe) and writes the actual chat_messages row.
        async function triggerAiStaffReply({ channelId, orderId, customerMessageId, customerMessageText }) {
            if (!channelId || !customerMessageId || !customerMessageText) return;
            try {
                const resp = await fetch('/api/support/ai-reply/' + encodeURIComponent(channelId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ customerMessageId, customerMessageText, orderId }),
                });
                if (!resp.ok) {
                    console.warn('[triggerAiStaffReply] non-200:', resp.status);
                    return;
                }
                const result = await resp.json().catch(() => ({}));
                if (result && result.sent) {
                    console.info('[triggerAiStaffReply] AI replied:', result.messageId);
                } else if (result && result.reason) {
                    console.info('[triggerAiStaffReply] skipped:', result.reason);
                }
            } catch (err) {
                console.warn('[triggerAiStaffReply] failed:', err && (err.message || err));
            }
        }

        let syncInitialized = false;

        async function syncOrdersFromBackend() {
            if (!syncInitialized) {
                syncInitialized = true;
            }

            // Restore selected order BEFORE loading (loadOrdersFromSupabase may reset it)
            restoreSelectedOrder();

            await loadOrdersFromSupabase();

            // Re-restore in case loadOrdersFromSupabase cleared it
            restoreSelectedOrder();

            // Auto-select the first order if none is selected (for order detail display)
            if (!selectedOrderId && ordersState.length > 0) {
                selectedOrderId = ordersState[0].id;
                persistSelectedOrder();
                renderOrders();
                renderDetail();
                initRealtimeThread(ordersState[0]);
                renderChat();
            }

            const syncAt = Date.now();
            els.syncLabel.textContent = 'Synced just now';

            renderOrders();
            renderCart();
            renderMetrics();
        }

        async function handleLogin(event) {
            event.preventDefault();
            const email = els.email.value.trim().toLowerCase();
            const password = els.password.value;

            if (!email || !password) {
                els.authHint.textContent = 'Please enter both email and password.';
                els.authHint.classList.remove('text-green-600');
                els.authHint.classList.add('text-red-600');
                return;
            }

            els.authHint.textContent = 'Signing in...';
            els.authHint.classList.remove('text-red-600', 'text-green-600');

            let serverSession = null;
            try {
                serverSession = await loginViaServer({ email, password, segment: config.segment });
            } catch (err) {
                els.authHint.textContent = err.message || 'Unable to sign in right now.';
                els.authHint.classList.remove('text-green-600');
                els.authHint.classList.add('text-red-600');
                return;
            }

            els.authHint.textContent = '';
            els.authHint.classList.remove('text-red-600');
            await loginWithSession(serverSession);
        }

        function parseMoneyAmount(value) {
            return Number(String(value || '0').replace(/[^0-9.-]/g, '')) || 0;
        }

        function parseOrderItemsForReturn(order) {
            if (Array.isArray(order.cartItems) && order.cartItems.length > 0) {
                return order.cartItems.map((item) => ({
                    product_id: item.id || item.product_code || null,
                    sku: item.product_code || item.id || null,
                    product_name: item.name || 'Order item',
                    quantity: Number(item.qty || item.quantity || 1),
                    unit_price: Number(item.price || item.unit_price || 0)
                }));
            }

            return [{
                product_name: order.product || order.item || `Order ${order.id}`,
                quantity: Number(order.quantity || 1) || 1,
                unit_price: parseMoneyAmount(order.amount) || 0
            }];
        }

        function totalReturnQuantity(items) {
            return items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) || 1;
        }

        async function syncFulfillmentOrder(order, sourceRowId = null) {
            const sourceNumber = order.id || order.order_number;
            if (!sourceNumber) return [];

            // Build structured items list from cart for stock tracking and customer tracing
            const cartItems = order.cartItems || [];
            const itemsList = cartItems.map((item) => ({
                item_code: item.id || item.product_code || null,
                item_name: item.name || 'Unknown Product',
                qty: Number(item.qty || 1),
            }));

            const fulfillmentRef = `FUL-${sourceNumber}`;
            return supabaseAPI({
                table: 'fulfillment_orders',
                operation: 'upsert',
                onConflict: 'fulfillment_id',
                returning: '*',
                data: {
                    fulfillment_id: fulfillmentRef,
                    fulfillment_code: fulfillmentRef,
                    order_id: String(sourceNumber),
                    purchase_id: config.segment === 'b2c' ? String(sourceRowId || sourceNumber) : null,
                    customer_name: session?.name || order.clientName || 'Customer',
                    shipping_address: session?.address || session?.shipping_address || '',
                    customer_phone: session?.phone || session?.customer_phone || null,
                    carrier: order.carrier,
                    service_type: config.segment === 'b2c' ? 'B2C Retail Delivery' : 'B2B Wholesale Delivery',
                    tracking_number: order.trackingNum || 'Pending',
                    status: 'Processing',
                    priority: config.segment === 'b2c' ? 'normal' : 'high',
                    order_date: new Date(order.createdAt || Date.now()).toISOString(),
                    notes: order.product || order.item || '',
                    items_json: itemsList.length > 0 ? JSON.stringify(itemsList) : null,
                }
            });
        }

        async function upsertReturnRequest(order) {
            const returnItems = parseOrderItemsForReturn(order);
            const rmaNumber = `RMA-${order.id}`;
            const lookupFilters = config.segment === 'b2c'
                ? { eq: { rma_number: rmaNumber } }
                : { eq: { rma_number: rmaNumber } };
            const existing = await supabaseAPI({
                table: 'logistic_returns',
                operation: 'select',
                filters: lookupFilters
            });

            const payload = {
                rma_number: rmaNumber,
                order_id: order.id,
                purchase_id: config.segment === 'b2c' ? String(order.dbId || order.id) : null,
                customer_name: order.clientName || session?.name || 'Customer',
                // Normalise so future email joins match the lowercase lookups used by
                // /customer-portal.js (loadOrdersFromSupabase) and customer-timeline.html.
                customer_email: String(session?.email || '').trim().toLowerCase(),
                return_items: returnItems,
                total_quantity: totalReturnQuantity(returnItems),
                reason: 'customer_refund_request',
                reason_details: `Refund requested from ${config.segment.toUpperCase()} customer portal for ${order.id}.`,
                status: 'requested',
                notes: 'Customer requested refund from portal.',
                refund_amount: parseMoneyAmount(order.amount),
                // Stock recovery: link back to the original fulfillment/sales records
                fulfillment_order_id: order.fulfillment_order_id || null,
                fulfillment_record_ids: order.fulfillment_record_ids || [],
                original_batch_ids: order.batch_ids || [],
                // Sales adjustment: used by /api/returns/process-refund to reduce sales totals
                return_items_detail: JSON.stringify(returnItems.map(it => ({
                    item_code: it.product_id || it.sku || it.product_name,
                    item_name: it.product_name,
                    returned_qty: it.quantity,
                    received_qty: 0,
                    unit_price: it.unit_price || 0,
                }))),
                sales_table: config.segment === 'b2c' ? 'retail_purchases' : 'orders',
                sales_id_field: config.segment === 'b2c' ? 'purchase_number' : 'order_number',
                total_sales_amount: parseMoneyAmount(order.amount),
                // Audit trail
                requested_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            if (existing && existing.length > 0) {
                await supabaseAPI({
                    table: 'logistic_returns',
                    operation: 'update',
                    data: payload,
                    filters: { eq: { id: existing[0].id } }
                });
                return existing[0];
            }

            const inserted = await supabaseAPI({
                table: 'logistic_returns',
                operation: 'insert',
                data: payload,
                returning: '*'
            });
            return Array.isArray(inserted) ? inserted[0] : inserted;
        }

        // Refund flow disabled. Historical refund messages from the support
        // chat may still appear with sender_name="Refund Gateway"; they are
        // preserved as audit trail. The button click below is the only thing
        // wired up — handler functions for handleRefundRequest /
        // upsertReturnRequest / openRefundChannel remain in the source for
        // archival but are no longer reachable.
        function handleRefundRequestDisabled() { /* refund self-service removed */ }

        async function handleRefundRequest() {
            if (!session || !selectedOrderId) return;
            const order = ordersState.find((item) => item.id === selectedOrderId);
            if (!order) return;

            const nowIso = new Date().toISOString();
            order.status = 'Refund Requested';
            order.refund_pending = true;
            order.rma_number = order.rma_number || `RMA-${order.id}`;
            order.updatedAt = Date.now();

            // Sync refund status via API. We touch FOUR tables so every dashboard
            // the rest of the ERP reads from agrees on the refund state:
            //   1. source order/purchase  — flip status/payment_status
            //   2. fulfillment_orders       — set refund_pending so the kiosk suppresses dispatch
            //   3. logistic_returns         — upsert RMA (done by upsertReturnRequest)
            //   4. chat_channels            — open / reuse a refund thread so Support Hub surfaces it
            try {
                if (config.segment === 'b2c') {
                    await supabaseAPI({
                        table: 'retail_purchases',
                        operation: 'update',
                        data: { status: 'Refund Requested', payment_status: 'Refunded', refund_pending: true, rma_number: order.rma_number },
                        filters: { eq: { purchase_number: order.id } }
                    });
                } else {
                    await supabaseAPI({
                        table: 'orders',
                        operation: 'update',
                        data: { status: 'Refund Requested', payment_status: 'Refunded', refund_pending: true, rma_number: order.rma_number },
                        filters: { eq: { order_number: order.id } }
                    });
                }

                // Mirror the flag onto the fulfillment row (if any) so the kiosk
                // hides the "Confirm Pickup" action and shows a refund banner.
                const fulfillmentId = order.fulfillment_order_id;
                if (fulfillmentId) {
                    try {
                        // Force a fresh column introspection. Without noCache:true
                        // the SQL proxy's cached column set can go stale (e.g. when
                        // the table gains new columns after first introspection) and
                        // reject valid writes with "No valid columns supplied". The
                        // cache TTL is short, but for refund writes we always want
                        // the latest schema, so re-introspect here.
                        await supabaseAPI({
                            table: 'fulfillment_orders',
                            operation: 'update',
                            data: { refund_pending: true, refund_requested_at: nowIso, rma_number: order.rma_number },
                            filters: { eq: { fulfillment_id: fulfillmentId } },
                            noCache: true
                        });
                    } catch (e) {
                        console.warn('[refund] fulfillment_orders flag update skipped:', e?.message || e);
                    }
                }

                // Persist the RMA row (historical — handler chain no longer reachable)
                const rmaRow = await upsertReturnRequest(order);

                // Open / reuse a refund-tagged support thread so the agent sees it
                // in /business-management/customer-management/support.html.
                let refundChannelId = currentChannelId || null;
                try {
                    refundChannelId = await openRefundChannel(order, order.rma_number, rmaRow);
                } catch (e) {
                    console.warn('[refund] channel upsert failed:', e?.message || e);
                }

                // Post the audit message into the refund channel.
                if (refundChannelId) {
                    try {
                        await supabaseAPI({
                            table: 'chat_messages',
                            operation: 'insert',
                            data: {
                                channel_id: refundChannelId,
                                thread_id: refundChannelId,
                                sender_id: 'system',
                                sender_name: 'Refund Gateway',
                                sender_role: 'system',
                                is_staff: false,
                                is_customer: false,
                                is_system: true,
                                message_type: 'system',
                                message_text: `Refund request for ${order.id} has been logged. RMA ${order.rma_number} attached. Our ${config.staff.role || 'support'} team will assess eligibility shortly.`
                            }
                        });
                    } catch (e) {
                        console.warn('[refund] system message insert failed:', e?.message || e);
                    }
                }
            } catch (err) {
                console.warn('Error processing refund request:', err);
            }

            renderOrders();
            renderDetail();
            const initOrder = ordersState.find((item) => item.id === selectedOrderId);
            initRealtimeThread(initOrder);
            renderChat();
            await syncOrdersFromBackend();
        }

        // Find or create a refund-tagged chat_channel for this order. Reuses the
        // existing order thread if one is already open so the customer can keep
        // messaging support in the same place. Marked with metadata.refund_pending
        // so the Support Hub can surface it ahead of regular chats.
        async function openRefundChannel(order, rmaNumber, rmaRow) {
            const channelType = config.segment === 'b2c' ? 'b2c_customer' : 'b2b_customer';
            const segmentLabel = config.segment.toUpperCase();

            // 1. Look for an existing channel already tagged to this order.
            let existing = [];
            try {
                existing = await supabaseAPI({
                    table: 'chat_channels',
                    operation: 'select',
                    filters: { eq: { order_id: String(order.id) } }
                });
            } catch (_) { existing = []; }

            // Prefer a channel that already has the same customer email so we
            // don't accidentally hijack a different customer's thread.
            const matchByEmail = (existing || []).find(c => {
                const meta = c.metadata || {};
                return meta.customer_email && session?.email &&
                    String(meta.customer_email).toLowerCase() === String(session.email).toLowerCase();
            });
            const fallback = (existing || [])[0];
            const chosen = matchByEmail || fallback;

            const metadata = {
                customer_email: String(session?.email || '').toLowerCase(),
                customer_name: session?.name || order.clientName || 'Customer',
                refund_pending: true,
                rma_number: rmaNumber,
                refund_amount: parseMoneyAmount(order.amount),
                rma_id: rmaRow?.id || null,
                refund_requested_at: new Date().toISOString()
            };

            if (chosen && chosen.id) {
                try {
                    await supabaseAPI({
                        table: 'chat_channels',
                        operation: 'update',
                        data: {
                            metadata: { ...(chosen.metadata || {}), ...metadata },
                            is_resolved: false,
                            priority: 'high'
                        },
                        filters: { eq: { id: chosen.id } }
                    });
                } catch (_) { /* tolerate missing priority column */ }
                return chosen.id;
            }

            // Otherwise insert a new refund-tagged channel.
            const inserted = await supabaseAPI({
                table: 'chat_channels',
                operation: 'insert',
                data: {
                    channel_type: channelType,
                    channel_name: `Refund ${rmaNumber} · ${order.id}`,
                    order_id: String(order.id),
                    team_name: `${segmentLabel} refund desk`,
                    color: '#dc2626',
                    is_resolved: false,
                    priority: 'high',
                    metadata,
                    created_at: new Date().toISOString(),
                    last_message_at: new Date().toISOString()
                },
                returning: '*'
            });
            return Array.isArray(inserted) ? (inserted[0]?.id || null) : (inserted?.id || null);
        }

        async function handleLogout() {
            await logoutViaServer();
            session = null;
            currentUser = null;
            renderAuth();
            renderCart();
            renderOrders();
        }

        async function handleCheckout() {
            if (checkoutInFlight) return;
            if (!session || session.segment !== config.segment || cart.length === 0) return;

            checkoutInFlight = true;
            const originalCheckoutText = els.checkoutBtn.textContent;
            els.checkoutBtn.disabled = true;
            els.checkoutBtn.textContent = 'Saving...';

            const order = buildOrder(config, session, cart);

            // Insert order via api-gateway edge function (which uses Supabase DB API, not PostgREST)
            // All tables (retail_purchases, orders) live in 'project' schema
            let savedOrderId = config.segment === 'b2c'
                ? `RET-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
                : order.id;
            let checkoutSucceeded = false;
            let checkoutError = '';
            const postCheckoutTasks = [];
            const cartSnapshot = cart.map((item) => ({ ...item }));
            const optimisticOrder = { ...order, id: savedOrderId, order_number: savedOrderId, cartItems: cartSnapshot };

            selectedOrderId = savedOrderId;
            persistSelectedOrder();
            ordersState = [optimisticOrder, ...ordersState.filter((item) => item.id !== savedOrderId)];

            try {
                if (config.segment === 'b2c') {
                    // B2C: Insert into retail_purchases
                    const total = cartSnapshot.reduce((sum, item) => sum + item.price * item.qty, 0);
                    const purchaseResult = await supabaseAPI({
                        table: 'retail_purchases',
                        operation: 'insert',
                        data: {
                            purchase_number: savedOrderId,
                            segment: 'b2c',
                            status: 'Confirmed',
                            payment_status: 'Pending',
                            subtotal: total,
                            total_amount: total,
                            carrier: order.carrier,
                            shipping_address: session.address || '',
                            customer_email: session.email,
                            customer_name: session.name,
                            customer_phone: session.phone || null,
                            purchase_date: new Date().toISOString(),
                            notes: cartSnapshot.map((item) => `${item.qty} x ${item.name}`).join(' | '),
                            items: cartSnapshot.map((item) => ({
                                product_id: item.id || null,
                                product_name: item.name,
                                quantity: item.qty,
                                unit_price: item.price,
                                total_price: item.price * item.qty,
                            }))
                        },
                        returning: 'id'
                    });

                    // Extract inserted ID from the api-gateway response (returns {data: [...], error: ...})
                    const purchaseId = Array.isArray(purchaseResult) && purchaseResult[0] ? purchaseResult[0].id : null;

                    if (!purchaseId) {
                        throw new Error('Retail purchase was not created.');
                    }

                    postCheckoutTasks.push(Promise.all(cartSnapshot.map((item) => supabaseAPI({
                        table: 'retail_purchase_items',
                        operation: 'insert',
                        data: {
                            purchase_id: purchaseId,
                            product_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id || '') ? item.id : null,
                            product_name: item.name,
                            quantity: item.qty,
                            unit_price: item.price,
                            total_price: item.price * item.qty
                        }
                    }))));
                    postCheckoutTasks.push(syncFulfillmentOrder(optimisticOrder, purchaseId));
                } else {
                    // B2B: Insert into customer_orders
                    savedOrderId = order.id;
                    const orderResult = await supabaseAPI({
                        table: 'orders',
                        operation: 'insert',
                        data: {
                            order_number: order.id,
                            segment: 'b2b',
                            status: 'Confirmed',
                            payment_status: 'Pending approval',
                            subtotal: parseFloat(order.amount.replace('$', '')),
                            total_amount: parseFloat(order.amount.replace('$', '')),
                            customer_name: session.name,
                            customer_email: session.email,
                            shipping_address: session.address || '',
                            carrier: order.carrier,
                            staff_name: order.staffName,
                            staff_role: order.staffRole,
                            notes: order.product,
                            items: cartSnapshot.map((item) => ({
                                product_id: item.id || null,
                                product_name: item.name,
                                quantity: item.qty,
                                unit_price: item.price,
                                total_price: item.price * item.qty,
                            }))
                        },
                        returning: 'id'
                    });

                    const orderId = Array.isArray(orderResult) && orderResult[0] ? orderResult[0].id : null;

                    if (!orderId) {
                        throw new Error('Wholesale order was not created.');
                    }

                    postCheckoutTasks.push(Promise.all(cartSnapshot.map((item) => supabaseAPI({
                        table: 'order_items',
                        operation: 'insert',
                        data: {
                            order_id: orderId,
                            product_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id || '') ? item.id : null,
                            product_name: item.name,
                            quantity: item.qty,
                            unit_price: item.price,
                            total_price: item.price * item.qty
                        }
                    }))));
                    postCheckoutTasks.push(syncFulfillmentOrder(optimisticOrder, orderId));
                }

                checkoutSucceeded = true;
            } catch (err) {
                console.warn('Error processing checkout:', err);
                if (err && err.code === 'INSUFFICIENT_FG_STOCK') {
                    const name = err.product_name || 'this item';
                    const short = err.short;
                    checkoutError = short && short > 0
                        ? `Sorry, only ${(err.requested - short)} units of "${name}" are in stock (you ordered ${err.requested}). Please reduce the quantity or check back later.`
                        : `Sorry, "${name}" is out of stock right now.`;
                } else {
                    checkoutError = err?.message || 'Unable to save the order right now.';
                }
            }

            if (!checkoutSucceeded) {
                checkoutInFlight = false;
                els.checkoutBtn.textContent = originalCheckoutText;
                els.successModal.classList.add('hidden');
                ordersState = ordersState.filter((item) => item.id !== savedOrderId);
                renderCart();
                renderOrders();
                renderDetail();
                if (els.authHint) {
                    els.authHint.textContent = `Checkout failed: ${checkoutError}`;
                    els.authHint.classList.remove('text-green-600');
                    els.authHint.classList.add('text-red-600');
                }
                return;
            }

            cart = [];
            saveCart(config.segment, cart);
            renderCart();
            renderOrders();
            renderDetail();
            renderChat();
            openSuccess(optimisticOrder);
            checkoutInFlight = false;
            els.checkoutBtn.textContent = originalCheckoutText;
            // Wait for all post-checkout DB writes (line items + fulfillment sync) before showing success
            try {
                await Promise.all(postCheckoutTasks);
            } catch (err) {
                console.warn('Order line item sync failed after checkout:', err);
            }
            syncOrdersFromBackend()
                .then(() => {
                    renderDetail();
                    const postSyncOrder = ordersState.find((item) => item.id === selectedOrderId);
                    initRealtimeThread(postSyncOrder);
                    renderChat();
                })
                .catch((err) => console.warn('Order ledger refresh failed after checkout:', err));
        }

        async function handleSendChat() {
            const text = els.chatInput.value.trim();
            if (!text || !session || !selectedOrderId) return;

            const order = ordersState.find((item) => item.id === selectedOrderId);
            if (!order) return;

            els.chatInput.value = '';

            const optimisticMsg = {
                id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                channel_id: currentChannelId,
                thread_id: currentThreadId,
                sender_id: 'customer',
                sender_name: session.name,
                sender_role: 'customer',
                is_staff: false,
                is_customer: true,
                is_system: false,
                message_type: 'message',
                message_text: text,
                _pending: true, // will be flipped to false on success; set to 'failed' on error
            };
            // Optimistic update — show immediately, persist async
            realtimeChats.push(optimisticMsg);
            renderChat();
            if (!backend.chats[selectedOrderId]) backend.chats[selectedOrderId] = [];
            backend.chats[selectedOrderId].push(optimisticMsg);
            saveJSON(BACKEND_KEY, backend);

            // Persist async. On failure we mark the message as failed so the
            // user can see it didn't actually reach the server, and we offer
            // a retry instead of a silent console.warn that nobody reads.
            //
            // The chat_messages.id column is a Postgres uuid, so we MUST NOT
            // send the optimistic `local-<ts>-<rand>` placeholder id (the DB
            // will reject the insert with 22P02 "invalid input syntax for
            // type uuid"). Drop both the id and the local _pending flag from
            // the outgoing payload — the DB will generate a real uuid, which
            // is then used to reconcile the optimistic message below.
            const { id: _optimisticId, _pending: _pendingFlag, ...persistPayload } = optimisticMsg;
            supabaseAPI({
                table: 'chat_messages',
                operation: 'insert',
                data: persistPayload
            }).then((inserted) => {
                // Server returned a row — promote the optimistic message to
                // the canonical id and clear the pending flag.
                const idx = realtimeChats.findIndex((m) => m.id === optimisticMsg.id);
                if (idx !== -1) {
                    const row = Array.isArray(inserted) ? inserted[0] : inserted;
                    realtimeChats[idx] = {
                        ...realtimeChats[idx],
                        ...(row && row.id ? { id: row.id, _pending: false } : { _pending: false }),
                    };
                }
                const storeIdx = (backend.chats[selectedOrderId] || []).findIndex((m) => m.id === optimisticMsg.id);
                if (storeIdx !== -1) {
                    backend.chats[selectedOrderId][storeIdx]._pending = false;
                    saveJSON(BACKEND_KEY, backend);
                }
                renderChat();
                // Fire-and-forget: ask the server to draft an AI staff reply.
                // 3s delay so it doesn't feel like an instant bot — and gives
                // a human staff typing at the same time a head start.
                const persistedRow = Array.isArray(inserted) ? inserted[0] : inserted;
                const persistedMessageId = persistedRow && persistedRow.id ? persistedRow.id : null;
                if (persistedMessageId) {
                    setTimeout(() => triggerAiStaffReply({
                        channelId: currentChannelId,
                        orderId: selectedOrderId,
                        customerMessageId: persistedMessageId,
                        customerMessageText: text,
                    }), 3000);
                }
            }).catch((err) => {
                console.warn('Error sending chat message:', err);
                // Mark the optimistic message as failed so re-render shows
                // the broken state (a retry button).
                const idx = realtimeChats.findIndex((m) => m.id === optimisticMsg.id);
                if (idx !== -1) {
                    realtimeChats[idx] = { ...realtimeChats[idx], _pending: 'failed' };
                    renderChat();
                }
                const storeIdx = (backend.chats[selectedOrderId] || []).findIndex((m) => m.id === optimisticMsg.id);
                if (storeIdx !== -1) {
                    backend.chats[selectedOrderId][storeIdx]._pending = 'failed';
                    saveJSON(BACKEND_KEY, backend);
                }
                const reason = err && (err.message || err.error_description) || 'Network error';
                showToast({
                    message: `We couldn't deliver your message: "${text.length > 40 ? text.slice(0, 40) + '…' : text}".`,
                    tone: 'error',
                    actionLabel: 'Retry',
                    onAction: () => retryChatMessage(optimisticMsg.id),
                    ttlMs: 12000,
                });
            });

            // Note: the legacy canned autoReply() was intentionally disabled
            // here to avoid a double-reply. The new AI-driven reply (see
            // triggerAiStaffReply above, fired 3s after a successful persist)
            // replaces it. If you need to re-enable canned replies temporarily
            // while debugging, restore the autoReply(order) call below.
            // autoReply(order);
        }

        async function retryChatMessage(localId) {
            const msg = realtimeChats.find((m) => m.id === localId)
                || (backend.chats[selectedOrderId] || []).find((m) => m.id === localId);
            if (!msg) return;
            // Strip the failed flag and the optimistic `local-...` id before
            // retrying — chat_messages.id is a uuid column and will reject
            // any non-uuid value with 22P02.
            const { id: _optimisticId, _pending, ...persistPayload } = msg;
            try {
                const inserted = await supabaseAPI({
                    table: 'chat_messages',
                    operation: 'insert',
                    data: persistPayload,
                });
                const row = Array.isArray(inserted) ? inserted[0] : inserted;
                const idx = realtimeChats.findIndex((m) => m.id === localId);
                if (idx !== -1) {
                    realtimeChats[idx] = {
                        ...realtimeChats[idx],
                        ...(row && row.id ? { id: row.id } : {}),
                        _pending: false,
                    };
                    renderChat();
                }
                const storeIdx = (backend.chats[selectedOrderId] || []).findIndex((m) => m.id === localId);
                if (storeIdx !== -1) {
                    backend.chats[selectedOrderId][storeIdx] = {
                        ...backend.chats[selectedOrderId][storeIdx],
                        _pending: false,
                    };
                    saveJSON(BACKEND_KEY, backend);
                }
                showToast({ message: 'Message sent.', tone: 'success', ttlMs: 3000 });
            } catch (err) {
                showToast({
                    message: 'Still couldn\'t deliver. Please try again in a moment.',
                    tone: 'error',
                    ttlMs: 6000,
                });
            }
        }

        function bindEvents() {
            els.loginForm.addEventListener('submit', handleLogin);
            els.logoutBtn.addEventListener('click', handleLogout);
            if (els.refundBtn) els.refundBtn.addEventListener('click', handleRefundRequestDisabled);
            els.checkoutBtn.addEventListener('click', handleCheckout);
            els.chatSend.addEventListener('click', handleSendChat);
            els.chatLauncher.addEventListener('click', () => setChatDrawerOpen(true));
            els.chatClose.addEventListener('click', () => setChatDrawerOpen(false));
            els.chatBackdrop.addEventListener('click', () => setChatDrawerOpen(false));
            els.chatInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSendChat();
                }
            });
            window.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') setChatDrawerOpen(false);
            });
            els.successClose.addEventListener('click', () => {
                els.successModal.classList.add('hidden');
            });
            window.addEventListener('storage', (event) => {
                // Cross-tab sync of the cart and the local backend cache.
                // The session cookie is invisible to JS (httpOnly), so we
                // can't observe login/logout events here — use the
                // visibilitychange / focus listener below for that.
                if (event.key === BACKEND_KEY || event.key === cartKey(config.segment)) {
                    cart = loadCart(config.segment);
                    renderAuth();
                    renderCart();
                    syncOrdersFromBackend();
                }
            });
            // When the user returns to this tab, re-check the server session
            // so a logout / cross-segment login in another tab takes effect.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    checkExistingSession();
                }
            });

            // Registration panel events. When the host page supplies a
            // registerUrl (e.g. B2B routes wholesale sign-ups to the dedicated
            // business-onboarding page), navigate to it instead of toggling
            // the inline register panel.
            if (els.showRegisterBtn) {
                els.showRegisterBtn.addEventListener('click', (event) => {
                    if (config && config.registerUrl) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        window.location.href = config.registerUrl;
                        return;
                    }
                    showRegisterPanel();
                });
            }
            if (els.backToLoginBtn) {
                els.backToLoginBtn.addEventListener('click', showLoginPanel);
            }
            if (els.registerForm) {
                els.registerForm.addEventListener('submit', handleRegister);
            }
            window.__espressgoPortalReady = true;
        }

        async function boot() {
            backend = ensureBackend(config);
            session = null;
            cart = loadCart(config.segment);

            renderCatalog(null);
            renderCart();
            renderOrders();
            renderAuth();
            bindEvents();
            window.__espressgoPortalReady = true;
            loadProductsFromSupabase()
                .then((liveProducts) => renderCatalog(liveProducts))
                .catch((err) => console.warn('Product catalog refresh failed:', err));
            syncOrdersFromBackend();
            setChatDrawerOpen(false);

            // Restore session from server (httpOnly cookie). The server is the
            // single source of truth — localStorage is never consulted.
            checkExistingSession();

            // Wire up Supabase Realtime subscriptions
            if (window.ERPRealtime) {
                window.ERPRealtime.refreshOn('orders', syncOrdersFromBackend);
                window.ERPRealtime.refreshOn('retail_purchases', syncOrdersFromBackend);
                window.ERPRealtime.refreshOn('inventory', () => {
                    loadProductsFromSupabase()
                        .then((liveProducts) => {
                            renderCatalog(liveProducts);
                            renderCart(); // refresh stock limit check on cart too
                        })
                        .catch((err) => console.warn('Product catalog refresh failed:', err));
                });
            }

            setInterval(syncOrdersFromBackend, 5000);
        }

        boot();
    }

    window.EspressGoCustomerPortal = { init };

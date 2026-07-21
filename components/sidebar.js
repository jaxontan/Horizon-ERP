class AppSidebar extends HTMLElement {
    constructor() {
        super();
        this.supabaseUrl = 'https://qsobpenorlpzlkeyiefg.supabase.co';
        this.supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzb2JwZW5vcmxwemxrZXlpZWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NDMwOTEsImV4cCI6MjA5MjMxOTA5MX0.RBJsOWvF0vfX_e6q_y2zpzvBKh_PA73cZ55I7CAm8M4';
        this.alertCount = 0;
        this._client = null;
    }

    _createClient() {
        if (!window.supabase) {
            this.initSupabaseSDK();
            return null;
        }
        // Guard: some pages (e.g. traceability.html) overwrite window.supabase with
        // a client object. In that case, reuse it instead of calling createClient.
        if (window.supabase.createClient && typeof window.supabase.createClient === 'function') {
            if (!this._client) {
                this._client = window.supabase.createClient(this.supabaseUrl, this.supabaseKey);
            }
            return this._client;
        }
        if (window.supabase.from && typeof window.supabase.from === 'function') {
            if (!this._client) this._client = window.supabase;
            return this._client;
        }
        return null;
    }

    async _ensureSession(client) {
        if (client) {
            try {
                const { data: { session } } = await client.auth.getSession();
                if (session) return;
            } catch(e) { /* ignore */ }
        }
    }

    async fetchAlerts() {
        try {
            const client = this._createClient();
            if (!client) {
                this.alertCount = 0;
                this.renderAlerts([]);
                this.updateAlertBadge();
                return;
            }
            await this._ensureSession(client);

            let orders = [], supportTickets = [], inventoryAlerts = [];

            try {
                const { data, error } = await client.from('customer_orders').select('id,order_id,status,created_at').order('created_at', { ascending: false }).limit(3);
                if (!error) orders = data || [];
            } catch(e) { /* table may not exist — skip */ }

            try {
                const { data, error } = await client.from('support_tickets').select('id,subject,status,created_at').order('created_at', { ascending: false }).limit(3);
                if (!error) supportTickets = data || [];
            } catch(e) { /* table may not exist — skip */ }

            try {
                const { data, error } = await client.from('inventory').select('item_code,name,current_stock').lt('current_stock', 20).eq('is_active', true).limit(3);
                if (!error) inventoryAlerts = data || [];
            } catch(e) { /* table may not exist — skip */ }

            const alerts = [];
            const now = new Date();

            (orders || []).forEach(o => {
                const mins = Math.round((now - new Date(o.created_at)) / 60000);
                const timeAgo = mins < 60 ? `${mins} min${mins !== 1 ? 's' : ''} ago` : `${Math.round(mins / 60)}h ago`;
                alerts.push({ type: 'order', icon: 'check_circle', color: 'green', text: `<span class="font-bold">Order</span> <span class="font-bold text-[#031635]">${o.order_number}</span> is <span class="font-bold text-[#031635]">${o.status}</span>.`, time: timeAgo });
            });

            (supportTickets || []).forEach(t => {
                const mins = Math.round((now - new Date(t.created_at)) / 60000);
                const timeAgo = mins < 60 ? `${mins} min${mins !== 1 ? 's' : ''} ago` : `${Math.round(mins / 60)}h ago`;
                const color = t.status === 'Open' ? 'red' : t.status === 'In Progress' ? 'amber' : 'blue';
                alerts.push({ type: 'ticket', icon: 'support_agent', color, text: `<span class="font-bold">Ticket:</span> <span class="font-bold text-[#031635]">${t.subject}</span> (${t.status}).`, time: timeAgo });
            });

            (inventoryAlerts || []).forEach(inv => {
                alerts.push({ type: 'inventory', icon: 'warning', color: 'amber', text: `<span class="font-bold">${inv.name}</span> (${inv.item_code}) below min stock: ${inv.current_stock} ${inv.warehouse_location || ''}`.trim(), time: 'Just now' });
            });

            this.alertCount = alerts.length;
            this.renderAlerts(alerts);
            this.updateAlertBadge();
        } catch (e) {
            console.warn('Sidebar alerts could not be loaded:', e);
        }
    }

    renderAlerts(alerts) {
        const container = document.getElementById('sidebar-alerts-list');
        if (!container) return;
        if (alerts.length === 0) {
            container.innerHTML = `<div class="p-3 text-center text-[11px] text-[#44474e] font-semibold">No new alerts.</div>`;
            return;
        }
        const colorMap = { green: 'text-green-600', amber: 'text-amber-600', red: 'text-red-600', blue: 'text-blue-600' };
        container.innerHTML = alerts.map(a => `
<div class="p-3 bg-[#ffffff] border border-[#c5c6cf] rounded-lg">
<div class="flex items-start gap-2">
<span class="material-symbols-outlined ${colorMap[a.color]} text-[16px] mt-0.5">${a.icon}</span>
<div>
<p class="text-[11px] text-[#191c1e] leading-tight">${a.text}</p>
<p class="text-[9px] text-[#44474e] mt-1">${a.time}</p>
</div>
</div>
</div>`).join('');
    }

    updateAlertBadge() {
        const badge = document.getElementById('alert-badge-count');
        const headerCount = document.querySelector('.sidebar-alert-header-count');
        if (badge) badge.textContent = this.alertCount;
        if (headerCount) headerCount.textContent = `${this.alertCount} Active Tasks`;
        // Collapsed header has no .sidebar-alert-header-count class — its "Loading…"
        // was rendered as literal text and never re-rendered. Sweep every alert-
        // header <p> in the shadow tree and replace any "Loading…" text with the
        // current count so the badge never looks permanently stuck.
        this.querySelectorAll('p').forEach((p) => {
            if (/^\s*loading[\s…]+$/i.test(p.textContent || '')) {
                p.textContent = `${this.alertCount} Active Tasks`;
            }
        });
    }

    /**
     * Render a skeleton placeholder so the page doesn't flash empty while we fetch
     * the user's department/role from Supabase. The user profile area still shows
     * immediately because it's pulled from localStorage.
     */
    renderSkeleton() {
        const layout = this.getAttribute('layout') || 'static';
        const isMobile = window.innerWidth <= 1024;
        const isMinimal = !isMobile && (localStorage.getItem('sidebar-minimal') === 'true');
        const widthClass = isMinimal ? 'w-20' : 'w-64';
        const textHiddenClass = isMinimal ? 'hidden' : '';

        const asideClass = layout === 'fixed'
            ? `flex flex-col border-r border-[#c5c6cf] bg-[#ffffff] justify-between transition-all duration-300`
            : `bg-[#ffffff] border-r border-[#c5c6cf] flex flex-col justify-between h-full flex-shrink-0 ${widthClass} transition-all duration-300`;
        const asideInlineStyle = layout === 'fixed'
            ? `position:fixed;left:0;top:0;height:100%;${isMinimal ? 'width:80px;' : 'width:256px;'};z-index:50;`
            : '';

        // 7 shimmer rows to match the 7 real sections
        const skeletonRows = Array.from({ length: 7 }, () => `
<div class="px-6 py-2">
  <div class="h-3 w-3/4 bg-[#eceef0] rounded animate-pulse"></div>
</div>`).join('');

        // Anchor main content offsets even while in skeleton state.
        // Only push main right if its parent chain doesn't already
        // provide the sidebar offset — some pages use a wrapper div
        // with ml-64 around <main> (see traceability.html,
        // purchase-record.html). Adding ml-64 on top of that double-
        // indents the content by another 256px.
        if (layout === 'fixed') {
            setTimeout(() => {
                const main = document.querySelector('main');
                if (main) {
                    main.classList.remove('ml-64', 'ml-20');
                    const parentHasOffset = main.parentElement
                        ? Array.from(main.parentElement.classList).some(c => c === 'ml-64' || c === 'ml-20')
                        : false;
                    if (!parentHasOffset) {
                        main.classList.add(isMinimal ? 'ml-20' : 'ml-64');
                    }
                    main.classList.add('transition-all', 'duration-300');
                }
            }, 0);
        }

        this.innerHTML = `
<div class="sidebar-mobile-backdrop" onclick="this.parentElement.closeSidebar ? this.parentElement.closeSidebar() : this.parentElement.classList.remove('sidebar-open')"></div>
<aside class="${asideClass}" ${asideInlineStyle ? `style="${asideInlineStyle}"` : ''} data-layout="${layout}" data-ismobile="${isMobile}" data-isminimal="${isMinimal}">
<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
<div class="p-3 relative shrink-0">
<div class="bg-[#eceef0] rounded-lg py-2 px-2.5 flex ${isMinimal ? 'justify-center' : 'justify-between'} items-center">
<div class="flex items-center">
<div class="bg-[#031635] text-[#ffffff] rounded-md p-1.5 ${isMinimal ? '' : 'mr-2.5'} relative">
<span class="material-symbols-outlined text-base">notifications</span>
<span class="absolute -top-1 -right-1 bg-[#ba1a1a] text-[#ffffff] text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-[#ffffff]">·</span>
</div>
<div class="${textHiddenClass} leading-tight">
<h3 class="font-semibold text-[13px]">Alert Center</h3>
<p class="text-[9px] text-[#44474e] uppercase tracking-wider leading-tight">Loading…</p>
</div>
</div>
<span class="material-symbols-outlined text-[#44474e] transition-transform ${textHiddenClass} text-[18px]">chevron_right</span>
</div>
</div>
<div class="px-4 pb-4 flex flex-col flex-1 min-h-0 overflow-hidden">
<nav class="flex-1 overflow-y-auto pr-1 space-y-1">
${skeletonRows}
</nav>
</div>
</div>
<div class="p-4 border-t border-[#c5c6cf] relative z-50 shrink-0">
<div class="flex items-center gap-3 px-1">
<div class="w-8 h-8 rounded-full bg-[#eceef0] animate-pulse"></div>
<div class="flex-1 ${textHiddenClass}">
<div class="h-3 w-1/2 bg-[#eceef0] rounded animate-pulse mb-1"></div>
<div class="h-2 w-1/3 bg-[#eceef0] rounded animate-pulse"></div>
</div>
</div>
</div>
</aside>
        `;
    }

    /**
     * Fetch the user's role and department from the server-validated
     * espressgo_staff_session cookie via /api/staff-session/me. No
     * localStorage fallback — the cookie is the only source of truth.
     *
     * Side effect: publishes the identity on `window.__staffIdentity` so
     * public/js/rbac.js can read it without re-fetching.
     *
     * @returns {Promise<{role: string|null, department: string, email: string} | null>}
     *          null when there is no valid staff session.
     */
    async fetchUserIdentity() {
        try {
            const resp = await fetch('/api/staff-session/me', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const data = await resp.json().catch(() => ({}));
            const session = data && data.session;
            if (!resp.ok || !session || !session.role) return null;

            const identity = {
                role: session.role,
                department: session.department || '',
                email: session.email || '',
                staff_id: session.staff_id || null,
                name: session.name || (session.email ? session.email.split('@')[0] : ''),
            };
            // Publish for rbac.js and any page that wants the current
            // identity without making another round trip.
            window.__staffIdentity = identity;
            return identity;
        } catch (e) {
            console.warn('[sidebar] fetchUserIdentity errored:', e && e.message ? e.message : e);
            return null;
        }
    }

    async connectedCallback() {
        // Auth guard: query /api/staff-session/me. The staff cookie is the
        // only authority — never localStorage.
        let identity = null;
        try {
            const probe = await fetch('/api/staff-session/me', {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const data = await probe.json().catch(() => ({}));
            if (probe.ok && data && data.session && data.session.role) {
                identity = {
                    role: data.session.role,
                    department: data.session.department || '',
                    email: data.session.email || '',
                    staff_id: data.session.staff_id || null,
                    name: data.session.name || (data.session.email ? data.session.email.split('@')[0] : ''),
                };
                window.__staffIdentity = identity;
            }
        } catch {
            identity = null;
        }

        if (!identity && !window.location.pathname.includes('/index.html')) {
            window.location.href = '/index.html';
            return;
        }

        this.injectResponsiveStyles();
        this.injectHamburger();

        // 1) Show skeleton immediately so layout doesn't shift
        this.renderSkeleton();

        // 2) Re-fetch (cached on the server side via the cookie) and render.
        //    If the first probe already succeeded, fetchUserIdentity will
        //    hit a 200 again — that's fine, it's a fast same-origin GET.
        if (!identity) identity = await this.fetchUserIdentity();
        if (!identity) {
            window.location.href = '/index.html';
            return;
        }

        // 3) Render the real sidebar filtered by department + role
        this.render(identity);
        setTimeout(() => this.fetchAlerts(), 800);
        setTimeout(() => {
            if (window.RBAC) window.RBAC.applyRBACToDOM();
        }, 50);
    }

    initSupabaseSDK() {
        if (!window.supabase || window.supabase._sbInit) return;
        window.supabase._sbInit = true;
        const sbUrl = this.supabaseUrl;
        const sbKey = this.supabaseKey;
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        script.onload = () => {
            if (window.supabase && window.supabase.createClient) {
                const client = window.supabase.createClient(sbUrl, sbKey);
                window.supabase._client = client;
            }
        };
        if (!document.head.querySelector('script[src*="supabase-js"]')) {
            document.head.appendChild(script);
        } else if (window.supabase && window.supabase.createClient) {
            window.supabase._client = window.supabase.createClient(sbUrl, sbKey);
        }
    }

    getSupabaseClient() {
        return new Promise((resolve) => {
            if (window.supabase && window.supabase._client) {
                resolve(window.supabase._client);
                return;
            }
            if (!window.supabase) {
                const sbUrl = this.supabaseUrl;
                const sbKey = this.supabaseKey;
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
                script.onload = () => {
                    const client = window.supabase.createClient(sbUrl, sbKey);
                    window.supabase._client = client;
                    resolve(client);
                };
                script.onerror = () => resolve(null);
                document.head.appendChild(script);
            } else {
                const client = window.supabase.createClient(this.supabaseUrl, this.supabaseKey);
                window.supabase._client = client;
                resolve(client);
            }
        });
    }

    /**
     * Mobile-first hamburger toggle.
     * - Hidden on desktop (≥1024px): `lg:hidden` overrides the default `flex`.
     * - Visible on tablet & mobile: tap to open the drawer.
     * - Clicking the backdrop or pressing Escape closes it.
     */
    injectHamburger() {
        if (document.getElementById('app-hamburger')) return;

        const btn = document.createElement('button');
        btn.id = 'app-hamburger';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Open navigation menu');
        btn.setAttribute('aria-controls', 'app-sidebar');
        btn.setAttribute('aria-expanded', 'false');
        // Mobile-first: visible by default; lg:hidden removes it on desktop ≥1024px.
        btn.className = 'fixed top-3 left-3 z-[1100] flex items-center justify-center w-10 h-10 rounded-lg bg-[#031635] text-white shadow-lg hover:bg-[#001b3d] active:scale-95 transition-all lg:hidden';
        btn.innerHTML = '<span class="material-symbols-outlined text-[22px]">menu</span>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openSidebar();
        });

        document.body.appendChild(btn);

        // Close drawer when viewport grows past the lg breakpoint (1024px) so
        // a desktop window resize leaves the sidebar in its proper state.
        const mq = window.matchMedia('(min-width: 1024px)');
        const onMq = (ev) => {
            if (ev.matches) this.closeSidebar();
        };
        if (mq.addEventListener) mq.addEventListener('change', onMq);
        else if (mq.addListener) mq.addListener(onMq);

        // Keyboard: Escape closes the drawer.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeSidebar();
        });
    }

    openSidebar() {
        this.classList.add('sidebar-open');
        const btn = document.getElementById('app-hamburger');
        if (btn) {
            btn.setAttribute('aria-expanded', 'true');
            btn.innerHTML = '<span class="material-symbols-outlined text-[22px]">close</span>';
        }
    }

    closeSidebar() {
        this.classList.remove('sidebar-open');
        const btn = document.getElementById('app-hamburger');
        if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            btn.innerHTML = '<span class="material-symbols-outlined text-[22px]">menu</span>';
        }
    }

    injectResponsiveStyles() {
        if (document.getElementById('sidebar-responsive-styles')) return;
        const style = document.createElement('style');
        style.id = 'sidebar-responsive-styles';
        style.textContent = `
            /* ===== MATERIAL SYMBOLS OUTLINED: self-hosted (no Google CDN dependency) =====
               The @fontsource/material-symbols-outlined package ships latin-{100..700}-normal
               .woff/.woff2 files. We register one @font-face per weight so the browser can
               pick the right one when an icon overrides font-variation-settings. Falls back
               to weight 400 if the requested weight file is unavailable. */
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-100-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-100-normal.woff") format("woff");
                font-weight: 100;
                font-style: normal;
                font-display: block;
            }
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-200-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-200-normal.woff") format("woff");
                font-weight: 200;
                font-style: normal;
                font-display: block;
            }
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-300-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-300-normal.woff") format("woff");
                font-weight: 300;
                font-style: normal;
                font-display: block;
            }
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-400-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-400-normal.woff") format("woff");
                font-weight: 400;
                font-style: normal;
                font-display: block;
            }
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-500-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-500-normal.woff") format("woff");
                font-weight: 500;
                font-style: normal;
                font-display: block;
            }
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-600-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-600-normal.woff") format("woff");
                font-weight: 600;
                font-style: normal;
                font-display: block;
            }
            @font-face {
                font-family: "Material Symbols Outlined";
                src: url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-700-normal.woff2") format("woff2"),
                     url("/node_modules/@fontsource/material-symbols-outlined/files/material-symbols-outlined-latin-700-normal.woff") format("woff");
                font-weight: 700;
                font-style: normal;
                font-display: block;
            }
            .material-symbols-outlined, [class*="material-symbols"] {
                font-family: "Material Symbols Outlined", sans-serif !important;
                font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 24;
                -webkit-font-smoothing: antialiased;
                font-display: block;
            }
            /* ===== GLOBAL: spacing for inline tab/filter strips (applies to all viewport sizes) ===== */
            /* Add breathing room above tab/filter strips so they don't look glued to the header.
               B2B page has its body content inside a div with p-8 (32px) padding which gives
               a clear gap above. Supplier page's tab strip sits directly inside main with only
               pt-16 (64px). This margin gives similar visual separation. */
            main > .bg-surface-container-lowest.rounded-xl.flex.gap-1,
            main > .bg-white.p-2.rounded-xl.border.border-outline-variant.shadow-sm,
            main > div > .bg-surface-container-lowest.rounded-xl.flex.gap-1 {
                margin-top: 1.5rem !important;
            }
            /* ===== GLOBAL: flatten tab/filter strips so they don't look like a duplicate header ===== */
            /* The supplier page's tab strip has bg-surface-container-lowest, border, and shadow
               which make it look like a second header bar. Flatten it to blend into the body.
               B2B's body content is just text/cards, not elevated boxes, so this matches. */
            main > .bg-surface-container-lowest.rounded-xl.flex.gap-1,
            main > div > .bg-surface-container-lowest.rounded-xl.flex.gap-1 {
                background: transparent !important;
                border: none !important;
                box-shadow: none !important;
            }
            /* ===== TABLET (768px–1024px): sidebar starts hidden, opens via hamburger ===== */
            @media (min-width: 768px) and (max-width: 1024px) {
                app-sidebar aside {
                    position: fixed !important;
                    left: 0 !important;
                    top: 0 !important;
                    height: 100vh !important;
                    transform: translateX(-100%) !important;
                    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
                    z-index: 1000 !important;
                    width: 280px !important;
                    overflow-y: auto !important;
                    overflow-x: hidden !important;
                }
                app-sidebar.sidebar-open aside {
                    transform: translateX(0) !important;
                }
                app-sidebar .sidebar-mobile-backdrop {
                    position: fixed;
                    inset: 0;
                    background-color: rgba(15, 23, 42, 0.6);
                    backdrop-filter: blur(4px);
                    z-index: 999;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.3s ease;
                }
                app-sidebar.sidebar-open .sidebar-mobile-backdrop {
                    opacity: 1;
                    pointer-events: auto;
                }

                /* Tablet: main content takes full width, hamburger offsets */
                .ml-64, main, [class*="ml-64"] {
                    margin-left: 0 !important;
                }
                main {
                    padding-left: 1.5rem !important;
                    padding-right: 1.5rem !important;
                    padding-top: 5rem !important;
                    padding-bottom: 1.5rem !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    gap: 1.5rem !important;
                }
                /* Add breathing room above tab/filter strips so they don't
                   look glued to the header (matches B2B's visual separation) */
                main > .bg-surface-container-lowest.rounded-xl,
                main > .bg-white.p-2.rounded-xl,
                main > .sticky.top-16 {
                    margin-top: 0.25rem !important;
                }
                header, header.fixed {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    /* Clear the hamburger button with a small visual gap.
                       Hamburger sits at 12-52px (left-3 + w-10). 56px padding puts the
                       title's icon just past the hamburger, giving ~4px breathing room. */
                    padding-left: 56px !important;
                    padding-right: 1.5rem !important;
                    padding-top: 0.5rem !important;
                    padding-bottom: 0.5rem !important;
                    height: 64px !important;
                    min-height: 64px;
                    flex-wrap: nowrap !important;
                    align-items: center !important;
                }
                header > * {
                    flex-wrap: nowrap;
                    min-width: 0;
                }
                .w-\\[calc\\(100\\%-16rem\\)\\], .max-w-\\[calc\\(100\\%-16rem\\)\\] {
                    width: 100% !important;
                    max-width: 100% !important;
                }
            }

            /* ===== MOBILE (<768px): sidebar becomes overlay drawer ===== */
            @media (max-width: 767px) {
                /* Prevent body horizontal overflow */
                html, body {
                    overflow-x: hidden !important;
                    max-width: 100vw !important;
                }

                /* Sidebar as mobile drawer */
                app-sidebar aside {
                    position: fixed !important;
                    left: 0 !important;
                    top: 0 !important;
                    height: 100vh !important;
                    transform: translateX(-100%) !important;
                    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
                    z-index: 1000 !important;
                    width: 280px !important;
                    overflow-y: auto !important;
                    overflow-x: hidden !important;
                }
                app-sidebar.sidebar-open aside {
                    transform: translateX(0) !important;
                }
                app-sidebar .sidebar-mobile-backdrop {
                    position: fixed;
                    inset: 0;
                    background-color: rgba(15, 23, 42, 0.6);
                    backdrop-filter: blur(4px);
                    z-index: 999;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.3s ease;
                }
                app-sidebar.sidebar-open .sidebar-mobile-backdrop {
                    opacity: 1;
                    pointer-events: auto;
                }

                /* Main content takes full width on mobile */
                .ml-64, main, [class*="ml-64"] {
                    margin-left: 0 !important;
                }
                main {
                    padding-left: 0.75rem !important;
                    padding-right: 0.75rem !important;
                    padding-top: 5rem !important;
                    padding-bottom: 1.5rem !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    gap: 1.5rem !important;
                }
                .w-\\[calc\\(100\\%-16rem\\)\\], .max-w-\\[calc\\(100\\%-16rem\\)\\], .w-\\[calc\\(100\\-256px\\)\\], .max-w-\\[calc\\(100\\-256px\\)\\] {
                    width: 100% !important;
                    max-width: 100% !important;
                }

                /* Header mobile: full-width pinned bar at the top of the viewport.
                   Use position:fixed so the header sits BESIDE the hamburger button
                   (overlapping at the top-left corner), not below it. */
                header, header.fixed {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    /* Clear the hamburger button with a small visual gap.
                       Hamburger sits at 12-52px (left-3 + w-10). 56px padding puts the
                       title's icon just past the hamburger, giving ~4px breathing room. */
                    padding-left: 56px !important;
                    padding-right: 0.75rem !important;
                    height: 64px !important;
                    min-height: 64px;
                    flex-wrap: nowrap !important;
                    align-items: center !important;
                }
                header > * {
                    flex-wrap: nowrap;
                    min-width: 0;
                }

                /* Hide verbose header elements on mobile (KEEP page title visible) */
                header .font-mono,
                header h1:not(.mobile-show),
                header nav:not(.mobile-show),
                header .flex-1.pr-2,
                header .h-6.w-\\[1px\\],
                header .h-8.w-px,
                header .flex.items-center.gap-4.justify-end > div:not(:first-child):not(button):not(.mobile-show),
                header [class*="bg-surface-container"]:not(.mobile-show) {
                    display: none !important;
                }
                /* Make the page title fit on one line alongside hamburger + bell */
                header h2.text-xl,
                header h1.text-xl {
                    font-size: 0.875rem !important;
                    line-height: 1.25 !important;
                    white-space: nowrap !important;
                    overflow: hidden !important;
                    text-overflow: ellipsis !important;
                    flex: 1 1 auto !important;
                    min-width: 0 !important;
                }
                /* Hide the title's icon on mobile to save space */
                header h2.text-xl > .material-symbols-outlined,
                header h1.text-xl > .material-symbols-outlined {
                    display: none !important;
                }

                /* Tabs navigation on mobile - catch both sticky tab strips AND inline tab containers */
                .sticky.top-16.z-30.ml-64,
                .sticky.top-16.z-30,
                .bg-surface-container-lowest.rounded-xl.flex.gap-1,
                .bg-white.p-2.rounded-xl.border.border-outline-variant.shadow-sm {
                    left: 0 !important;
                    width: 100% !important;
                    max-width: 100% !important;
                    padding-left: 0.75rem !important;
                    padding-right: 0.75rem !important;
                    overflow-x: auto !important;
                    box-sizing: border-box !important;
                    /* Remove elevated look so it doesn't look like a duplicate header */
                    background: transparent !important;
                    border: none !important;
                    box-shadow: none !important;
                }
                .sticky.top-16.z-30 nav,
                .bg-surface-container-lowest.rounded-xl.flex.gap-1 > a,
                .bg-white.p-2.rounded-xl.border.border-outline-variant.shadow-sm > * {
                    flex-shrink: 0 !important;
                    white-space: nowrap !important;
                }

                /* Global padding overrides (skip the header — it has its own
                   padding-left rule above that clears the hamburger button). */
                .px-margin:not(header), [class*="p-margin"]:not(header), [class*="px-margin"]:not(header) {
                    padding-left: 0.75rem !important;
                    padding-right: 0.75rem !important;
                }

                /* Selection bar mobile */
                #selection-bar {
                    left: 0.5rem !important;
                    right: 0.5rem !important;
                    transform: none !important;
                    bottom: 1rem !important;
                    width: auto !important;
                    max-width: none !important;
                    flex-wrap: wrap !important;
                    justify-content: center !important;
                }

                /* Modal mobile: full screen */
                [id$="-modal"]:not([id$="-modal"] .transform),
                #prediction-modal,
                [id$="-modal"] > div,
                [id$="-modal"] > div:first-child {
                    max-width: 100% !important;
                    width: 100% !important;
                    border-radius: 0 !important;
                    margin: 0 !important;
                }
                [id$="-modal"] .transform {
                    max-width: 100% !important;
                    width: 100% !important;
                    border-radius: 0 !important;
                    max-height: 100vh !important;
                }

                /* Chat drawer on mobile */
                #chat-drawer {
                    width: 100% !important;
                    max-width: 100% !important;
                    border-radius: 0 !important;
                }
            }

            /* ===== VERY SMALL SCREENS (<480px) ===== */
            @media (max-width: 479px) {
                header .mobile-show-if-tiny {
                    display: flex !important;
                }
                .grid {
                    grid-template-columns: 1fr !important;
                }
                .grid-cols-2 {
                    grid-template-columns: 1fr !important;
                }
                .grid-cols-3 {
                    grid-template-columns: 1fr !important;
                }
                .grid-cols-4 {
                    grid-template-columns: repeat(2, 1fr) !important;
                }
            }

            /* ===== GLOBAL: Table horizontal scroll wrapper (all screen sizes) ===== */
            .table-scroll-wrapper {
                overflow-x: auto !important;
                -webkit-overflow-scrolling: touch !important;
            }
            .table-scroll-wrapper table {
                min-width: 600px !important;
            }

            /* ===== GLOBAL: Ensure grid children don't overflow ===== */
            .overflow-x-auto {
                overflow-x: auto !important;
                -webkit-overflow-scrolling: touch;
            }

            /* ===== SIDEBAR OVERLAY Z-INDEX CORRECTIONS ===== */
            app-sidebar aside {
                box-shadow: 2px 0 20px rgba(0,0,0,0.1);
            }

            /* ===== DRAWER OPEN: shrink main+header so content isn't squished ===== */
            /* Only effective at ≤1024px where the sidebar is a drawer (not the
               always-visible desktop sidebar). On desktop, .sidebar-open is
               never toggled so this rule has no effect there. */
            app-sidebar.sidebar-open ~ main {
                margin-left: 280px !important;
                width: calc(100% - 280px) !important;
                max-width: calc(100% - 280px) !important;
                transition: margin-left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                            width 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            }
            app-sidebar.sidebar-open ~ header {
                left: 280px !important;
                width: calc(100% - 280px) !important;
                max-width: calc(100% - 280px) !important;
                transition: left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                            width 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            }
        `;
        document.head.appendChild(style);
    }

    render(identity) {
        // The identity arg is the authoritative source. localStorage is never
        // consulted here — that was the source of the privilege escalation
        // bug. window.__staffIdentity is the published mirror populated by
        // connectedCallback / fetchUserIdentity.
        const cached = (typeof window !== 'undefined' && window.__staffIdentity) || null;
        const ident = identity || cached || { role: '', department: '' };
        const layout = this.getAttribute('layout') || 'static';
        const isMobile = window.innerWidth <= 1024;
        const isMinimal = !isMobile && (localStorage.getItem('sidebar-minimal') === 'true');
        const widthClass = isMinimal ? 'w-20' : 'w-64';
        const textHiddenClass = isMinimal ? 'hidden' : '';
        const iconContainerClass = isMinimal ? 'justify-center' : '';

        const asideClass = layout === 'fixed'
            ? `flex flex-col border-r border-[#c5c6cf] bg-[#ffffff] justify-between transition-all duration-300`
            : `bg-[#ffffff] border-r border-[#c5c6cf] flex flex-col justify-between h-full flex-shrink-0 ${widthClass} transition-all duration-300`;
        const asideInlineStyle = layout === 'fixed'
            ? `position:fixed;left:0;top:0;height:100%;${isMinimal ? 'width:80px;' : 'width:256px;'};z-index:50;`
            : '';

        // Only push main right if its parent chain doesn't already
        // provide the sidebar offset — some pages use a wrapper div
        // with ml-64 around <main> (see traceability.html,
        // purchase-record.html). Adding ml-64 on top of that double-
        // indents the content by another 256px.
        if (layout === 'fixed') {
            setTimeout(() => {
                const main = document.querySelector('main');
                if (main) {
                    main.classList.remove('ml-64', 'ml-20');
                    const parentHasOffset = main.parentElement
                        ? Array.from(main.parentElement.classList).some(c => c === 'ml-64' || c === 'ml-20')
                        : false;
                    if (!parentHasOffset) {
                        main.classList.add(isMinimal ? 'ml-20' : 'ml-64');
                    }
                    main.classList.add('transition-all', 'duration-300');
                }
            }, 0);
        }

        const navSections = [
            {
                title: 'Business Ops',
                items: [
                    { id: 'supplier-management', href: '/business-management/Supplier-management/index.html', icon: 'handshake', label: 'Supplier Relations' },
                    { id: 'customer-master', href: '/business-management/customer-management/index.html', icon: 'groups', label: 'Customer Master' },
                    { id: 'sales-dashboard', href: '/business-management/customer-management/customer-order/index.html', icon: 'bar_chart', label: 'Sales Dashboard' },
                    { id: 'outreach', href: '/business-management/outreach/email-outreach.html', icon: 'mail', label: 'Marketing Outreach' }
                ]
            },
            {
                title: 'Communication Hub',
                items: [
                    { id: 'support-hub', href: '/business-management/customer-management/support.html', icon: 'support_agent', label: 'Support Hub' }
                ]
            },
            {
                title: 'Finances & Reports',
                items: [
                    { id: 'finance-dashboard', href: '/business-management/finances/opertation.html', icon: 'account_balance', label: 'Finance Dashboard' },
                    { id: 'purchase-record', href: '/document/purchase-record.html', icon: 'shopping_bag', label: 'Purchase Records' }
                ]
            },
            {
                title: 'Document Hub',
                items: [
                    { id: 'traceability', href: '/document/traceability.html', icon: 'assignment_turned_in', label: 'Batch Tracing' }
                ]
            },
            {
                title: 'Logistics & Dispatch',
                items: [
                    { id: 'fulfillment', href: '/logistic/fulfillment.html', icon: 'assignment', label: 'Order Fulfillment' }
                ]
            },
                    {
                title: 'Warehouse',
                items: [
                    { id: 'warehouse-stock', href: '/warehouse/inventory.html', icon: 'inventory_2', label: 'Stock Management' },
                    { id: 'production', href: '/production/index.html', icon: 'timeline', label: 'Production Pipeline' },
                    { id: 'production-recipes', href: '/warehouse/recipes.html', icon: 'menu_book', label: 'Production Recipes' },
                    { id: 'factory-booking', href: '/factory-booking/index.html', icon: 'precision_manufacturing', label: 'Factory & Gear Booking' }
                ]
            },
            {
                title: 'Staff Management',
                items: [
                    { id: 'staff-management', href: '/staff-management/clock-in.html', icon: 'badge', label: 'Staff Attendance & Roster' },
                    { id: 'create-staff', href: '/staff-management/create-staff.html', icon: 'person_add', label: 'Provision Staff' },
                    { id: 'staff-salaries', href: '/staff-management/salaries.html', icon: 'payments', label: 'Staff Salaries' }
                ]
            },
            {
                title: 'Settings & Security',
                items: [
                    { id: 'rbac-admin',    href: '/settings/rbac.html',         icon: 'admin_panel_settings', label: 'RBAC Admin' },
                    { id: 'alert-center',  href: '/settings/alert-center.html', icon: 'shield_lock',          label: 'Alert Center' }
                ]
            }
        ];

        // ── RBAC: get current role and department, build visibility helpers ───────
        // Identity comes from the server cookie via /api/staff-session/me;
        // never from localStorage.
        const currentRole = ident.role || '';
        const currentDepartment = ident.department || '';
        const userEmail    = ident.email || '';
        const userName    = ident.email ? ident.email.split('@')[0] : '';

        const roleLabels = {
            admin:       'Administrator',
            accountant:  'Finance & Accounting',
            procurement: 'Procurement',
            production:  'Production',
            logistic:    'Logistics',
            sales:       'Sales & Customer',
            client:      'Customer',
        };
        const roleBadgeColors = {
            admin:       'text-red-600',
            accountant:  'text-purple-600',
            procurement: 'text-blue-600',
            production:  'text-orange-600',
            logistic:    'text-teal-600',
            sales:       'text-green-600',
            client:      'text-slate-500',
        };

        // Per-item filter (legacy role-based): keeps fine-grained restrictions like
        // create-staff being admin-only even inside a visible section.
        function canSeeNavItem(navId) {
            // Fail closed: if RBAC isn't loaded, hide the item rather than
            // exposing it. The page-level guardPage() will redirect.
            if (!window.RBAC) return false;
            const perm = window.RBAC.NAV_PERMISSIONS[navId];
            if (!perm) return true;
            return window.RBAC.can(perm);
        }

        // Section-level filter: which section does the user's (role, department)
        // combination permit them to see? Delegated to public/js/rbac.js.
        function canSeeSection(sectionTitle) {
            // Fail closed: hide the section if RBAC isn't loaded.
            if (!window.RBAC || !window.RBAC.canSeeSection) return false;
            return window.RBAC.canSeeSection(sectionTitle, currentRole, currentDepartment);
        }

        let navHTML = '';
        let visibleSectionCount = 0;
        navSections.forEach(section => {
            // Gate the whole section by the department+role matrix first…
            if (!canSeeSection(section.title)) return;
            // …then apply the per-item permission filter inside it.
            const visibleItems = section.items.filter(item => canSeeNavItem(item.id));
            if (visibleItems.length === 0) return;
            visibleSectionCount++;

            navHTML += `
<div class="px-6 pt-4 pb-1 text-[10px] font-black text-[#44474e]/60 uppercase tracking-widest ${textHiddenClass}">${section.title}</div>
`;
            visibleItems.forEach(item => {
                navHTML += `
<a class="flex items-center py-2 text-[#44474e] hover:bg-[#f2f4f6] transition-colors group nav-link ${isMinimal ? 'justify-center px-0' : 'px-6'}" href="${item.href}" data-page="${item.id}" data-rbac="${window.RBAC ? window.RBAC.NAV_PERMISSIONS[item.id] || '' : ''}" title="${item.label}">
<span class="material-symbols-outlined ${isMinimal ? '' : 'mr-3'} text-[18px] group-hover:text-[#191c1e]">${item.icon}</span>
<span class="text-xs font-semibold group-hover:text-[#191c1e] ${textHiddenClass}">${item.label}</span>
</a>`;
            });
        });

        // Empty state: friendly message when no sections are visible to this user.
        if (visibleSectionCount === 0) {
            navHTML = `
<div class="px-6 pt-6 pb-2 text-center">
  <span class="material-symbols-outlined text-[#44474e] text-2xl">lock</span>
  <p class="text-xs font-semibold text-[#44474e] mt-2 ${textHiddenClass}">No sections available</p>
  <p class="text-[10px] text-[#44474e]/70 mt-1 ${textHiddenClass}">Your role (${currentRole || 'unknown'}) and department (${currentDepartment || 'none'}) don't have access to any modules.</p>
</div>`;
        }

        this.innerHTML = `
<div class="sidebar-mobile-backdrop" onclick="this.parentElement.closeSidebar ? this.parentElement.closeSidebar() : this.parentElement.classList.remove('sidebar-open')"></div>
<aside class="${asideClass}" ${asideInlineStyle ? `style="${asideInlineStyle}"` : ''} data-layout="${layout}" data-ismobile="${isMobile}" data-isminimal="${isMinimal}">
<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
<div class="p-3 relative shrink-0">
<div class="bg-[#eceef0] rounded-lg py-2 px-2.5 flex ${isMinimal ? 'justify-center' : 'justify-between'} items-center cursor-pointer hover:bg-[#e6e8ea] transition-colors" onclick="window.location.href='/settings/alert-center.html'">
<div class="flex items-center">
<div class="bg-[#031635] text-[#ffffff] rounded-md p-1.5 ${isMinimal ? '' : 'mr-2.5'} relative">
<span class="material-symbols-outlined text-base">notifications</span>
<span id="alert-badge-count" class="absolute -top-1 -right-1 bg-[#ba1a1a] text-[#ffffff] text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-[#ffffff]">0</span>
</div>
<div class="${textHiddenClass} leading-tight">
<h3 class="font-semibold text-[13px]">Alert Center</h3>
<p class="text-[9px] text-[#44474e] uppercase tracking-wider sidebar-alert-header-count leading-tight">0 Active Tasks</p>
</div>
</div>
<span id="alert-chevron" class="material-symbols-outlined text-[#44474e] transition-transform ${textHiddenClass} text-[18px]">chevron_right</span>
</div>

<div id="sidebar-alert-content" class="hidden absolute top-4 left-full ml-2 w-80 max-h-[400px] overflow-y-auto bg-[#ffffff] border border-[#c5c6cf] rounded-xl shadow-xl z-[100] flex-col gap-2 p-3">
<style>
#sidebar-alert-content::-webkit-scrollbar { width: 4px; }
#sidebar-alert-content::-webkit-scrollbar-track { background: transparent; }
#sidebar-alert-content::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
</style>
<div id="sidebar-alerts-list">
<!-- Dynamically populated from Supabase -->
</div>
<div class="flex gap-1.5 mt-1 border-t border-[#c5c6cf]/30 pt-1.5">
<button onclick="markAllAlertsRead()" class="w-1/2 text-[10px] font-bold text-slate-500 py-1.5 hover:bg-[#f2f4f6] rounded transition-colors">Mark All Read</button>
<a href="/settings/alert-center.html" class="w-1/2 text-center text-[10px] font-extrabold text-blue-600 hover:text-blue-800 py-1.5 hover:bg-slate-50 rounded transition-colors flex items-center justify-center gap-0.5">
<span>Full Feed</span>
<span class="material-symbols-outlined text-[12px]">open_in_new</span>
</a>
</div>
</div>
</div>
<div class="px-4 pb-4 flex flex-col flex-1 min-h-0 overflow-hidden">

<style>
#sidebar-nav::-webkit-scrollbar { width: 3px; }
#sidebar-nav::-webkit-scrollbar-track { background: transparent; }
#sidebar-nav::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }

app-sidebar .material-symbols-outlined {
    font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24 !important;
}
app-sidebar .bg-\[\#d6e3ff\] .material-symbols-outlined {
    font-variation-settings: 'FILL' 1, 'wght' 700, 'GRAD' 0, 'opsz' 24 !important;
}
</style>
<nav class="flex-1 overflow-y-auto pr-1 space-y-1" id="sidebar-nav">
${navHTML}
</nav>
</div>
</div>
<div class="p-4 border-t border-[#c5c6cf] relative z-50 shrink-0">
<div class="space-y-1">
<a class="flex items-center py-2 text-[#031635] hover:bg-[#031635]/5 transition-colors ${isMinimal ? 'justify-center px-0' : 'px-2'} rounded" href="/customer-page/index.html" title="Customer Portal">
<span class="material-symbols-outlined ${isMinimal ? '' : 'mr-3'} text-lg text-[#031635]">storefront</span>
<span class="text-sm font-bold ${textHiddenClass} text-[#031635]">Customer Portal</span>
</a>
<button onclick="toggleSidebarMinimal()" class="w-full flex items-center py-2 text-[#44474e] hover:text-[#191c1e] transition-colors ${isMinimal ? 'justify-center px-0' : 'px-2'} rounded hover:bg-[#f2f4f6]" title="${isMinimal ? 'Expand Sidebar' : 'Collapse Sidebar'}">
<span class="material-symbols-outlined ${isMinimal ? '' : 'mr-3'} text-lg transition-transform duration-300 ${isMinimal ? 'rotate-180' : ''}">chevron_left</span>
<span class="text-sm font-medium ${textHiddenClass}">Collapse</span>
</button>
</div>

<div class="flex ${isMinimal ? 'flex-col gap-3 items-center' : 'items-center justify-between px-1'} mt-4 pt-4 border-t border-[#c5c6cf]/50">
<div class="flex items-center min-w-0 text-left p-1.5 w-full">
<div class="w-8 h-8 rounded-full bg-[#031635] text-white flex items-center justify-center font-black text-xs shrink-0 flex-shrink-0" style="font-size:14px;line-height:1;">
${(userName || 'U').charAt(0).toUpperCase()}
</div>
<div class="${textHiddenClass} ml-3 truncate flex-1 pr-2">
<p class="text-xs font-bold text-[#191c1e] truncate">${userName}</p>
<p class="text-[9px] ${roleBadgeColors[currentRole] || 'text-slate-500'} font-black tracking-widest uppercase">${roleLabels[currentRole] || ''}</p>
</div>
</div>
<button onclick="handleLogout()" class="p-1.5 hover:bg-[#ba1a1a]/10 text-[#44474e] hover:text-[#ba1a1a] rounded transition-colors flex shrink-0" title="Logout">
<span class="material-symbols-outlined text-[18px]">logout</span>
</button>
</div>
</div>
</aside>
        `;
        const path = window.location.pathname.toLowerCase();
        let activePage = '';
        // Match the path segment immediately after "/settings/". Order matters:
        // alert-center must be tested before rbac.html because both live in /settings/.
        if (path.endsWith('/settings/alert-center.html'))        activePage = 'alert-center';
        else if (path.endsWith('/settings/rbac.html'))          activePage = 'rbac-admin';

        else if (path.endsWith('/business-management/supplier-management/timeline.html')
              || path.endsWith('/business-management/supplier-management/onboard.html')
              || path.endsWith('/business-management/supplier-management/details.html')) {
            activePage = 'supplier-management';
        }
        else if (path.includes('/business-management/supplier-management/')) activePage = 'supplier-management';

        else if (path.endsWith('/business-management/customer-management/customer-timeline.html')) {
            activePage = 'customer-timeline';
        }
        else if (path.endsWith('/business-management/customer-management/big-business/customer-verification.html')) {
            activePage = 'customer-verification';
        }
        else if (path.endsWith('/business-management/customer-management/customer-order/b2b.html')
              || path.endsWith('/business-management/customer-management/customer-order/b2c.html')
              || path.endsWith('/business-management/customer-management/customer-order/details.html')) {
            activePage = 'sales-dashboard';
        }
        else if (path.includes('/business-management/customer-management/customer-order/')) activePage = 'sales-dashboard';
        else if (path.endsWith('/business-management/customer-management/') || path.endsWith('/business-management/customer-management/index.html')) activePage = 'customer-master';
        else if (path.endsWith('/business-management/customer-management/support.html')) activePage = 'support-hub';

        else if (path.endsWith('/business-management/outreach/email-outreach.html')) activePage = 'outreach';
        else if (path.includes('/business-management/outreach/')) activePage = 'outreach';

        else if (path.endsWith('/business-management/finances/opertation.html')) activePage = 'finance-dashboard';

        else if (path.endsWith('/document/traceability.html')) activePage = 'traceability';
        else if (path.endsWith('/document/purchase-record.html')) activePage = 'purchase-record';

        else if (path.endsWith('/logistic/fulfillment.html')) activePage = 'fulfillment';

        else if (path.endsWith('/warehouse/inventory.html')) activePage = 'warehouse-stock';
        else if (path.endsWith('/warehouse/recipes.html'))    activePage = 'production-recipes';

        else if (path.endsWith('/production/index.html')) activePage = 'production';
        else if (path.includes('/production/')) activePage = 'production';

        else if (path.endsWith('/factory-booking/index.html')) activePage = 'factory-booking';

        else if (path.endsWith('/staff-management/clock-in.html'))     activePage = 'staff-management';
        else if (path.endsWith('/staff-management/index.html'))        activePage = 'staff-management';
        else if (path.endsWith('/staff-management/management.html'))   activePage = 'staff-management';
        else if (path.endsWith('/staff-management/create-staff.html')) activePage = 'create-staff';
        else if (path.endsWith('/staff-management/salaries.html'))     activePage = 'staff-salaries';

        if (activePage) {
            const link = this.querySelector(`a[data-page="${activePage}"]`);
            if (link) {
                const isMinimal = localStorage.getItem('sidebar-minimal') === 'true';
                link.className = `flex items-center py-2 bg-[#d6e3ff] text-[#001b3d] transition-colors nav-link ${isMinimal ? 'justify-center px-0' : 'px-6'}`;
                link.innerHTML = link.innerHTML.replace(/group-hover:text-\[#191c1e\]/g, '').replace(/font-semibold/g, 'font-black');

                const wrapper = document.createElement('div');
                wrapper.className = "relative flex flex-col";
                const indicator = document.createElement('div');
                indicator.className = "absolute left-0 top-0 bottom-0 w-1 bg-[#031635] rounded-r";

                link.parentNode.insertBefore(wrapper, link);
                wrapper.appendChild(indicator);
                wrapper.appendChild(link);
            }
        }
    }
}

// Global secure logout handler
window.handleLogout = async function() {
    // Clear the server cookie. Don't bother with Supabase JS signOut — the
    // password grant JWT was never stored on the client.
    try {
        await fetch('/api/staff-session/logout', {
            method: 'POST',
            credentials: 'same-origin',
        });
    } catch (err) {
        console.warn('Staff logout request failed:', err);
    }
    // Clean up legacy localStorage keys so a stale UI value can't be replayed
    // if the user navigates without a hard refresh.
    try {
        localStorage.removeItem('user-role');
        localStorage.removeItem('user-email');
        localStorage.removeItem('staff-name');
        localStorage.removeItem('staff-dept');
        localStorage.removeItem('staff-role');
        localStorage.removeItem('staff-id');
        localStorage.removeItem('supabase-access-token');
        localStorage.removeItem('supabase-auth-refresh-token');
        localStorage.removeItem('supabase-user-id');
    } catch { /* localStorage may be blocked */ }
    window.__staffIdentity = null;
    window.location.href = '/index.html';
};

// Click outside handler for Popovers

if (typeof window.toggleAlertCenter !== 'function') {
    window.toggleAlertCenter = function() {
        window.location.href = '/settings/alert-center.html';
    };
}

if (typeof window.toggleSidebarMinimal !== 'function') {
    window.toggleSidebarMinimal = function() {
        const isMinimal = localStorage.getItem('sidebar-minimal') === 'true';
        const nextMinimal = !isMinimal;
        localStorage.setItem('sidebar-minimal', nextMinimal);

        const sidebar = document.querySelector('app-sidebar');
        if (sidebar && typeof sidebar.render === 'function') {
            sidebar.render();
        }

        window.dispatchEvent(new CustomEvent('sidebar-minimal-changed', { detail: { isMinimal: nextMinimal } }));
    };
}

customElements.define('app-sidebar', AppSidebar);

// Global Supabase client accessor — safe to call from any page script.
// Returns a promise that resolves with the Supabase client instance.
window.initSupabaseClient = window.initSupabaseClient || function() {
    return new Promise(function(resolve) {
        var SB_URL = 'https://qsobpenorlpzlkeyiefg.supabase.co';
        var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzb2JwZW5vcmxwemxrZXlpZWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NDMwOTEsImV4cCI6MjA5MjMxOTA5MX0.RBJsOWvF0vfX_e6q_y2zpzvBKh_PA73cZ55I7CAm8M4';
        if (window.supabase && window.supabase._client) {
            resolve(window.supabase._client);
            return;
        }
        if (!window.supabase) {
            var script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
            script.onload = function() {
                var client = window.supabase.createClient(SB_URL, SB_KEY);
                window.supabase._client = client;
                resolve(client);
            };
            script.onerror = function() { resolve(null); };
            document.head.appendChild(script);
        } else {
            var client = window.supabase.createClient(SB_URL, SB_KEY);
            window.supabase._client = client;
            resolve(client);
        }
    });
};

// Returns a promise that resolves with a fresh access token from the live SDK session.
// Never reads directly from localStorage (tokens get stale after refresh).
window.getAccessToken = window.getAccessToken || function() {
    return new Promise(function(resolve) {
        var SB_URL = 'https://qsobpenorlpzlkeyiefg.supabase.co';
        var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzb2JwZW5vcmxwemxrZXlpZWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NDMwOTEsImV4cCI6MjA5MjMxOTA5MX0.RBJsOWvF0vfX_e6q_y2zpzvBKh_PA73cZ55I7CAm8M4';
        if (window.supabase && window.supabase._client) {
            window.supabase._client.auth.getSession().then(function(result) {
                resolve(result.data.session ? result.data.session.access_token : null);
            }).catch(function() { resolve(null); });
            return;
        }
        if (!window.supabase) {
            var script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
            script.onload = function() {
                var client = window.supabase.createClient(SB_URL, SB_KEY);
                window.supabase._client = client;
                client.auth.getSession().then(function(result) {
                    resolve(result.data.session ? result.data.session.access_token : null);
                }).catch(function() { resolve(null); });
            };
            script.onerror = function() { resolve(null); };
            document.head.appendChild(script);
        } else {
            var client = window.supabase.createClient(SB_URL, SB_KEY);
            window.supabase._client = client;
            client.auth.getSession().then(function(result) {
                resolve(result.data.session ? result.data.session.access_token : null);
            }).catch(function() { resolve(null); });
        }
    });
};

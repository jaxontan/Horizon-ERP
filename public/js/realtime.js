(async function () {
    if (window.__erpRealtimeLoaded) return;
    window.__erpRealtimeLoaded = true;

    console.log('[ERP Realtime] Initializing Realtime Hub...');

    const client = await window.initSupabaseClient();
    if (!client) {
        console.error('[ERP Realtime] Supabase client could not be initialized.');
        return;
    }

    const channels = new Map(); // table -> channel
    const handlers = new Map(); // table -> Set of handlers
    const ignoredTables = new Set();

    // Simple debounce helper
    function debounce(fn, delay) {
        let timer = null;
        return function (...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                fn.apply(this, args);
            }, delay);
        };
    }

    function ensureChannel(table) {
        if (ignoredTables.has(table)) {
            console.log(`[ERP Realtime] Table '${table}' is ignored globally. Skipping auto-subscription.`);
            return;
        }

        if (channels.has(table)) return;

        console.log(`[ERP Realtime] Subscribing to changes on table: ${table}`);
        
        const channel = client.channel(`rt:${table}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: table }, (payload) => {
                console.log(`[ERP Realtime] Change detected in table '${table}':`, payload);
                
                // Invoke registered handlers
                const tableHandlers = handlers.get(table);
                if (tableHandlers) {
                    tableHandlers.forEach(handler => {
                        try {
                            handler(payload);
                        } catch (e) {
                            console.error(`[ERP Realtime] Error executing handler for table '${table}':`, e);
                        }
                    });
                }

                // Dispatch custom event
                window.dispatchEvent(new CustomEvent(`rt:${table}`, { detail: payload }));
            })
            .subscribe((status) => {
                console.log(`[ERP Realtime] Subscription status for '${table}':`, status);
            });

        channels.set(table, channel);
    }

    function on(table, handler) {
        if (!handlers.has(table)) {
            handlers.set(table, new Set());
        }
        handlers.get(table).add(handler);
        ensureChannel(table);

        return {
            unsubscribe: () => {
                off(table, handler);
            }
        };
    }

    function off(table, handler) {
        const tableHandlers = handlers.get(table);
        if (tableHandlers) {
            tableHandlers.delete(handler);
            if (tableHandlers.size === 0) {
                const channel = channels.get(table);
                if (channel) {
                    console.log(`[ERP Realtime] Unsubscribing from table channel: ${table}`);
                    client.removeChannel(channel);
                    channels.delete(table);
                }
                handlers.delete(table);
            }
        }
    }

    function refreshOn(table, reloadFn, opts = {}) {
        const ms = opts.debounce !== undefined ? opts.debounce : 300;
        
        const debounced = debounce(() => {
            console.log(`[ERP Realtime] Executing reload for table: ${table}`);
            reloadFn();
        }, ms);

        const sub = on(table, debounced);
        return sub;
    }

    function ignore(table) {
        ignoredTables.add(table);
        const channel = channels.get(table);
        if (channel) {
            client.removeChannel(channel);
            channels.delete(table);
        }
    }

    // Flush pending operations from the stub
    const stub = window.ERPRealtime;
    const pending = (stub && stub._pending) || [];

    const realRealtime = {
        on,
        off,
        refreshOn,
        ignore,
        _channels: channels,
        _handlers: handlers
    };
    window.ERPRealtime = realRealtime;

    pending.filter(p => p.type === 'ignore').forEach(p => {
        ignore(p.table);
    });

    pending.forEach(p => {
        if (p.type === 'on') {
            const sub = on(p.table, p.handler);
            p.realUnsubscribe = sub.unsubscribe;
        } else if (p.type === 'off') {
            off(p.table, p.handler);
        } else if (p.type === 'refreshOn') {
            refreshOn(p.table, p.reloadFn, p.opts);
        }
    });

    console.log('[ERP Realtime] Realtime Hub initialized & pending registrations flushed.');
})();

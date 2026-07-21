tailwind.config = {
    darkMode: "class",
    theme: {
        extend: {
            "colors": {
                "primary": "#031635",
                "on-primary": "#ffffff",
                "surface-container-low": "#f2f4f6",
                "surface-container-lowest": "#ffffff",
                "surface-container": "#eceef0",
                "surface-container-high": "#e6e8ea",
                "surface-container-highest": "#e0e3e5",
                "surface-bright": "#f7f9fb",
                "surface-dim": "#d8dadc",
                "surface": "#f7f9fb",
                "background": "#f7f9fb",
                "on-surface": "#191c1e",
                "on-surface-variant": "#44474e",
                "on-background": "#191c1e",
                "outline": "#75777f",
                "outline-variant": "#c5c6cf",
                "secondary": "#475f87",
                "secondary-container": "#b7d0fe",
                "secondary-fixed": "#d6e3ff",
                "secondary-fixed-dim": "#afc7f5",
                "on-secondary": "#ffffff",
                "on-secondary-fixed": "#001b3d",
                "on-secondary-fixed-variant": "#2f476e",
                "on-secondary-container": "#405880",
                "primary-container": "#1a2b4b",
                "primary-fixed": "#d8e2ff",
                "primary-fixed-dim": "#b6c6ef",
                "on-primary-fixed": "#081b3a",
                "on-primary-fixed-variant": "#364768",
                "on-primary-container": "#8293b8",
                "inverse-surface": "#2d3133",
                "inverse-on-surface": "#eff1f3",
                "inverse-primary": "#b6c6ef",
                "tertiary": "#0f1821",
                "tertiary-fixed": "#dbe3f0",
                "tertiary-fixed-dim": "#bfc7d4",
                "tertiary-container": "#242c36",
                "on-tertiary": "#ffffff",
                "on-tertiary-fixed": "#141c25",
                "on-tertiary-fixed-variant": "#3f4750",
                "on-tertiary-container": "#8b939f",
                "surface-tint": "#4e5e81",
                "error": "#ba1a1a",
                "error-container": "#ffdad6",
                "on-error": "#ffffff",
                "on-error-container": "#93000a"
            },
            "borderRadius": {
                "DEFAULT": "0.125rem",
                "lg": "0.25rem",
                "xl": "0.5rem",
                "full": "0.75rem"
            },
            "spacing": {
                "unit": "4px",
                "stack-md": "16px",
                "margin": "32px",
                "gutter": "24px",
                "container-max": "1440px",
                "stack-sm": "8px",
                "stack-lg": "24px"
            },
            // ─────────────────────────────────────────────────────────────────
            // FONT FAMILIES
            // ─────────────────────────────────────────────────────────────────
            // Two ecosystems:
            //   1) Internal staff app: Inter (body) + Manrope (headings)
            //   2) Customer portal: Plus Jakarta Sans (body) + Outfit (headings)
            //      + Playfair Display (decorative accent)
            //
            // Semantic tokens (font-body-md, font-headline-lg, etc.) bundle
            // font-family with matching font-size/weight so you can't accidentally
            // pair the wrong font with the wrong size.
            //
            // Reference: docs/font-system.md
            // ─────────────────────────────────────────────────────────────────
            "fontFamily": {
                // Tailwind defaults — set so font-sans / font-display work
                // consistently across the codebase without per-page overrides.
                "sans": ["Inter", "system-ui", "sans-serif"],
                "display": ["Manrope", "sans-serif"],

                // Internal app — body / label / data tokens
                "label-md": ["Inter"],
                "data-tabular": ["Inter"],
                "body-md": ["Inter"],
                "body-lg": ["Inter"],

                // Internal app — heading tokens
                "headline-sm": ["Manrope"],
                "headline-md": ["Manrope"],
                "headline-lg": ["Manrope"],

                // Customer portal — body / heading / accent tokens
                "customer-body": ["Plus Jakarta Sans", "system-ui", "sans-serif"],
                "customer-heading": ["Outfit", "sans-serif"],
                "customer-accent": ["Playfair Display", "Georgia", "serif"],

                // Legacy aliases (kept so old code that references them still works)
                "tabular": ["Inter"]
            },
            "fontSize": {
                // Internal app body / label / data sizes
                "label-md": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
                "data-tabular": ["13px", { "lineHeight": "18px", "fontWeight": "500" }],
                "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
                "body-lg": ["16px", { "lineHeight": "24px", "fontWeight": "400" }],

                // Internal app heading sizes
                "headline-sm": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
                "headline-md": ["24px", { "lineHeight": "32px", "letterSpacing": "-0.01em", "fontWeight": "600" }],
                "headline-lg": ["30px", { "lineHeight": "38px", "letterSpacing": "-0.02em", "fontWeight": "700" }],

                // Customer portal sizes
                "customer-body": ["15px", { "lineHeight": "24px", "fontWeight": "400" }],
                "customer-heading-sm": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
                "customer-heading-md": ["28px", { "lineHeight": "36px", "letterSpacing": "-0.01em", "fontWeight": "700" }],
                "customer-heading-lg": ["40px", { "lineHeight": "48px", "letterSpacing": "-0.02em", "fontWeight": "800" }],
                "customer-accent": ["18px", { "lineHeight": "28px", "fontStyle": "italic", "fontWeight": "400" }]
            },
            "letterSpacing": {
                // Customer portal decorative letter-spacings (legacy inline values
                // consolidated into semantic tokens so every file uses the same scale).
                // See docs/font-system.md for the canonical letter-spacing scale.
                "headline-tight": "-0.02em",   // used on large headings
                "headline-medium": "-0.01em",  // used on mid headings
                "label-wide": "0.08em",        // uppercase category labels
                "label-wider": "0.12em",       // uppercase micro-labels
                "label-widest": "0.18em"       // uppercase hero/eyebrow labels
            }
        },
    },
    // ─────────────────────────────────────────────────────────────────
    // GLOBAL: Material Symbols Outlined icon font
    // ─────────────────────────────────────────────────────────────────
    // Ensures the icon font always wins over Tailwind's font-* utilities
    // (font-headline-sm, font-body-md, etc.) which would otherwise apply a
    // text font that has no icon glyphs, causing them to render as plain text.
    // The !important is intentional — Tailwind utility specificity competes
    // with this rule in the cascade, so we force a winner here.
    // Loaded before the Tailwind CDN builds its sheet so this is present
    // at first paint.
    //
    // Reference: https://developers.google.com/fonts/docs/material_symbols
    // ─────────────────────────────────────────────────────────────────
    corePlugins: {
        preflight: true,
    },
};

// Inject the icon font base rule before Tailwind's CDN script compiles styles.
(function injectMaterialSymbolsRule() {
    if (typeof document === 'undefined') return;
    const css = `
        .material-symbols-outlined {
            font-family: 'Material Symbols Outlined' !important;
            font-weight: normal !important;
            font-style: normal !important;
            line-height: 1;
            letter-spacing: normal;
            text-transform: none;
            display: inline-block;
            white-space: nowrap;
            word-wrap: normal;
            direction: ltr;
            -webkit-font-feature-settings: 'liga';
            -webkit-font-smoothing: antialiased;
            font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
            vertical-align: middle;
        }
    `;
    const style = document.createElement('style');
    style.id = 'material-symbols-base';
    style.appendChild(document.createTextNode(css));
    // Insert at the very top of <head> so our rule precedes any other stylesheet
    // Tailwind will inject. Even with !important, this gives us a stable position.
    (document.head || document.documentElement).appendChild(style);
})();
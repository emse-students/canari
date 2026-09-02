import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPackage = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const appVersion = appPackage.version || '0.0.0';

// eslint-disable-next-line no-undef
const host = process.env.TAURI_DEV_HOST;
const devOrigin = host ? `http://${host}:1420` : undefined;

// The host port the LOCAL nginx container publishes (`infrastructure/local/docker-compose.yml`).
// Every `/api/*` request from the dev server goes here rather than to a service, because nginx is
// where a bearer token becomes the `X-User-Id` header the services read - see the proxy block
// below. Overridable for a second estate on one machine, which is why it is not a literal.
const devApiPort = process.env.CANARI_LOCAL_API_PORT || '8081';

/**
 * Stubs out the WASM loader for Tauri builds (AppImage, Android, etc.).
 *
 * When the TAURI_TARGET env var is set, any import of `mlsWasmLoader` is
 * redirected to a virtual module that throws if ever called. This prevents
 * Vite from resolving or bundling the .wasm assets in native Tauri builds,
 * where TauriMlsService is used instead.
 *
 * @returns {import('vite').Plugin}
 */
function mlsWasmStub() {
  // eslint-disable-next-line no-undef
  const isTauri = !!process.env.TAURI_TARGET;
  const VIRTUAL_ID = '\0mls-wasm-stub';
  return {
    name: 'mls-wasm-stub',
    resolveId(id) {
      if (isTauri && id.includes('mlsWasmLoader')) {
        return VIRTUAL_ID;
      }
    },
    load(id) {
      if (id === VIRTUAL_ID) {
        return `export async function loadAndInitWasm() {
  throw new Error('[mls-wasm-stub] WASM is not available in Tauri builds - TauriMlsService should be used instead.');
}`;
      }
    },
  };
}

/** @returns {import('vite').Plugin} */
function protobufPatch() {
  return {
    name: 'protobuf-patch',
    transform(code, id) {
      // https://github.com/protobufjs/protobuf.js/issues/1754
      if (id.endsWith('@protobufjs/inquire/index.js')) {
        return {
          code: code.replace(`eval("quire".replace(/^/,"re"))`, 'require'),
          map: null,
        };
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
  },
  plugins: [
    mlsWasmStub(),
    tailwindcss(),
    // Paraglide must compile before SvelteKit so the generated runtime in
    // src/lib/paraglide is available to the app. SPA mode (ssr=false): locale
    // detection is client-side via localStorage then the browser's preferred
    // language, falling back to the base locale (fr).
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
    sveltekit(),
    protobufPatch(),
  ],

  // Pre-bundle Tauri/heavy deps at startup so Vite never re-optimizes them
  // mid-session - which triggers an HMR full-reload that Android WebView
  // cannot handle (Failed to fetch dynamically imported module).
  //
  // THIS LIST WAS HALF THE DEPENDENCIES, AND AN INCOMPLETE LIST BUYS NOTHING. Measured 2026-09-03
  // on a cold cache: the optimizer discovered 36 more packages in four waves and forced THREE full
  // page reloads, the last of them logging the very error this comment was written about. A reload
  // is not merely slow - it destroyed an OIDC login in flight, because an authorization code is
  // single-use, so the local estate looked broken when only the dev server was. It would equally
  // void a campaign measurement mid-run.
  //
  // So the rule is: anything imported anywhere in the app belongs here, not just the heavy or
  // native things. Every entry below was OBSERVED being discovered - none is speculative - and the
  // way to extend the list is to read `dependencies optimized:` out of the dev-server log after
  // exercising a new route, never to guess.
  optimizeDeps: {
    include: [
      '@humanspeak/svelte-markdown',
      '@lucide/svelte',
      '@tauri-apps/api/app',
      '@tauri-apps/api/core',
      '@tauri-apps/api/window',
      '@tauri-apps/plugin-biometric',
      '@tauri-apps/plugin-deep-link',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-fs',
      '@tauri-apps/plugin-http',
      '@tauri-apps/plugin-log',
      '@tauri-apps/plugin-notification',
      '@tauri-apps/plugin-opener',
      '@tauri-apps/plugin-os',
      '@tauri-apps/plugin-sql',
      '@tauri-apps/plugin-store',
      '@tauri-apps/plugin-websocket',
      '@zumer/snapdom',
      'emoji-picker-element',
      'emoji-picker-element/i18n/en',
      'highlight.js/lib/core',
      'highlight.js/lib/languages/bash',
      'highlight.js/lib/languages/c',
      'highlight.js/lib/languages/cpp',
      'highlight.js/lib/languages/css',
      'highlight.js/lib/languages/go',
      'highlight.js/lib/languages/java',
      'highlight.js/lib/languages/javascript',
      'highlight.js/lib/languages/json',
      'highlight.js/lib/languages/kotlin',
      'highlight.js/lib/languages/markdown',
      'highlight.js/lib/languages/php',
      'highlight.js/lib/languages/plaintext',
      'highlight.js/lib/languages/python',
      'highlight.js/lib/languages/rust',
      'highlight.js/lib/languages/sql',
      'highlight.js/lib/languages/typescript',
      'highlight.js/lib/languages/xml',
      'highlight.js/lib/languages/yaml',
      'jspdf',
      'pdfjs-dist',
      // Both specifiers, because they are two cache entries: the app imports the extensionless one
      // and the generated `src/lib/proto/canari.js` imports `protobufjs/minimal.js`.
      'protobufjs/minimal',
      'protobufjs/minimal.js',
      'qrcode',
      'svelte-dnd-action',
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || '0.0.0.0',
    origin: devOrigin,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    // ONE ENTRY POINT, BECAUSE AUTHENTICATION LIVES IN NGINX AND NOWHERE ELSE.
    //
    // This block used to name each service directly - `/api/users` to 3012, `/api/mls/` to 3010,
    // and so on - which skips nginx, and nginx is what turns a bearer token into the
    // `X-User-Id` header every service actually reads. So a local login SUCCEEDED and then every
    // authenticated request answered
    // `401 Missing X-User-Id header - ensure the request passes through nginx auth`.
    // Measured 2026-09-02 by performing a real login against the local estate.
    //
    // TWO OF THE OLD ENTRIES FORGED PART OF THAT WORK: `/api/mls/` and `/api/calls/` set
    // `x-user-logged-in: true` by hand, unconditionally. That is worse than the 401 - it made an
    // unauthenticated caller look logged in, locally only, on exactly the routes the MLS work is
    // measured on. Both are gone with the rest of the table.
    //
    // The nginx config (`infrastructure/local/Dockerfile.frontend`, the single source of truth for
    // it) covers every `/api/*` route this table did and NINE FAMILIES IT DID NOT - `/api/admin`,
    // `/api/groups`, `/api/payments`, `/api/moderation`, `/api/external`, `/api/minesweeper`,
    // `/api/public/`, `/api/media/public/` and the calendar `.ics` feed - which were therefore
    // broken in local development and are not any more. It reproduces both rewrites this table
    // performed (`/api/call` -> `/ws`, `/api/chat-delivery-health` -> `/api/health`) and upgrades
    // websockets, so routing through it loses nothing.
    //
    // `/channels` and `/ws` stay direct: they are not under `/api/`, and nginx has no location for
    // either. `/ws` is the client's own alias for `/api/ws`.
    proxy: {
      '/api': {
        target: `http://localhost:${devApiPort}`,
        changeOrigin: true,
        ws: true,
      },
      // Bare `/channels` - social-service's own path, with no `/api` prefix and no nginx location.
      '/channels': {
        target: 'http://localhost:3014',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
        rewrite: () => '/api/ws',
      },
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and all Rust build artifacts.
      // mls-core/target and mls-wasm/target contain hundreds of thousands of files
      // (doc HTML, object files) that exhaust the system inotify watcher limit,
      // causing ENOSPC errors that crash the dev server before the window loads.
      ignored: ['**/src-tauri/**', '**/target/**', '**/.git/**'],
    },
    fs: {
      strict: false,
    },
  },
}));

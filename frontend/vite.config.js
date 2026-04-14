import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

// eslint-disable-next-line no-undef
const host = process.env.TAURI_DEV_HOST;
const devOrigin = host ? `http://${host}:1420` : undefined;

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
  plugins: [tailwindcss(), sveltekit(), protobufPatch()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    origin: devOrigin,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    proxy: {
      // Proxy the delivery-service API so VITE_DELIVERY_URL is not needed in local dev.
      // Requests to /mls-api/* and /history/* are forwarded to the NestJS service.
      '/mls-api': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        rewrite: (/** @type {string} */ path) => `/api${path}`,
        headers: { 'x-user-logged-in': 'true' },
      },
      '/history': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        rewrite: (/** @type {string} */ path) => `/api${path}`,
        headers: { 'x-user-logged-in': 'true' },
      },
      '/api/mls-api': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        headers: { 'x-user-logged-in': 'true' },
      },
      '/api/history': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        headers: { 'x-user-logged-in': 'true' },
      },
      '/api/channels': {
        target: 'http://localhost:3014',
        changeOrigin: true,
      },
      // Proxy /channels API to social-service
      '/channels': {
        target: 'http://localhost:3014',
        changeOrigin: true,
      },
      // Proxy /api/posts API to social-service
      '/api/posts': {
        target: 'http://localhost:3014',
        changeOrigin: true,
      },
      // Proxy /ws WebSocket to the chat-gateway so VITE_GATEWAY_URL is not needed in local dev.
      '/api/presence': { target: 'http://localhost:3000', changeOrigin: true },

      // Added proxies for other services:
      '/api/auth': { target: 'http://localhost:3012', changeOrigin: true },
      '/api/users': { target: 'http://localhost:3012', changeOrigin: true },
      '/api/media': { target: 'http://localhost:3011', changeOrigin: true },
      '/api/forms': { target: 'http://localhost:3014', changeOrigin: true },
      '/api/associations': { target: 'http://localhost:3014', changeOrigin: true },

      // WebSocket proxy — /api/ws must be listed before the /ws fallback
      '/api/ws': {
        target: 'ws://localhost:3000',
        ws: true,
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

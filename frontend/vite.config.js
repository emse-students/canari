import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

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
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    proxy: {
      // Proxy the delivery-service API so VITE_HISTORY_URL is not needed in local dev.
      // Requests to /mls-api/* and /history/* are forwarded to the NestJS service.
      '/mls-api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/history': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Proxy /channels API to channel-service
      '/channels': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      // Proxy /ws WebSocket to the chat-gateway so VITE_GATEWAY_URL is not needed in local dev.
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
    fs: {
      strict: false,
    },
  },
}));

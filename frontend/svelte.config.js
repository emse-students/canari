// The app ships as one SPA (`ssr = false` in src/routes/+layout.ts) to two very different hosts.
//
// Tauri has no Node.js server, so it gets adapter-static with an index.html fallback - the
// historical setup, and still the default here. The WEB deploy gets adapter-node instead, purely
// so a server exists to write per-page <head> tags into the shell before it is sent: no component
// renders server-side either way, but a crawler or an unfurler never runs the client, so without a
// server every Open Graph tag the app emits is invisible to the one audience it is written for
// (see src/hooks.server.ts).
//
// The polarity is deliberate: adapter-static is what you get unless BUILD_WEB is set, so a Tauri
// or local build can never accidentally produce a Node server it cannot run. Only the CD web build
// opts in.
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const buildsForWeb = !!process.env.BUILD_WEB;

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: buildsForWeb ? adapterNode() : adapterStatic({ fallback: 'index.html' }),
    prerender: {
      // `/sitemap.xml` is NOT here: it is built per request now, because a crawler can only learn
      // an association or post URL from it (see routes/sitemap.xml/+server.ts).
      entries: [
        '/robots.txt',
        '/app-shell',
        '/.well-known/assetlinks.json',
        '/.well-known/apple-app-site-association',
      ],
    },
  },
};

export default config;

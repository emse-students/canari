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
    // RELATIVE ASSET PATHS ARE RIGHT FOR TAURI AND WRONG FOR THE WEB, and the default is relative.
    //
    // SvelteKit writes `./_app/immutable/...` into every prerendered page, which a browser resolves
    // against the DIRECTORY of the URL it was served from. That is what Tauri needs - it serves the
    // build from an opaque root and one file has to work wherever it lands. On the web it makes the
    // ONE page that exists to survive an outage unable to survive one: nginx answers @app_shell with
    // `/app-shell.html` on whatever URL was asked for, so on `/auth/callback` the browser goes
    // looking for `/auth/_app/immutable/...`, which is not a file - it falls through to @ssr, the
    // upstream that is down, and comes back as HTML. Every module then dies on its MIME type and the
    // fallback renders nothing at all. Measured on the local estate 2026-09-04 while frontend-ssr
    // was missing: `/chat` booted (one segment, so `./` is the root) and `/auth/callback` did not,
    // which is the login landing.
    //
    // Absolute paths cost the web build nothing: it is served from the origin root by nginx and by
    // adapter-node alike. So the polarity follows the adapter, exactly as it does above.
    paths: { relative: !buildsForWeb },
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

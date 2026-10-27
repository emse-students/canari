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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webDocumentCsp } from './src/lib/security/cspPolicy.js';

const buildsForWeb = !!process.env.BUILD_WEB;

/** Process-wide memo slot: `Symbol.for` survives every re-import of this file, a user-visible env var would not die with the build. */
const STAMP_KEY = Symbol.for('canari.buildVersionName');

/**
 * THE BUILD NAMES ITS OWN COMMIT. `kit.version.name` is written verbatim into `/_app/version.json`;
 * it used to be `Date.now()` alone, so the cross-client rig INFERRED the commit as "the newest one at
 * or before that instant" - an inference that moves when a commit lands carrying an earlier date
 * (a pull, a rebase). `<builtAtMs>-<sha>` keeps the timestamp, which is what tells two builds of the
 * SAME commit apart for the `updated` poll, and adds the identity. Read by
 * `tools/cross-client-harness/results.mjs` (`parseBuildStamp`).
 *
 * IT THROWS WITHOUT GIT, deliberately: every build of this app runs from a checkout (CI's jobs, the
 * Tauri builds, a workstation - the Docker image COPIES a build, it never makes one), so a missing
 * repository is a build nobody could attribute, and naming it by a guess would be the fallback this
 * repository forbids.
 */
function buildVersionName() {
  const slot = /** @type {Record<symbol, string | undefined>} */ (
    /** @type {unknown} */ (globalThis)
  );
  const memo = slot[STAMP_KEY];
  if (memo) return memo;
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    throw new Error(
      `kit.config.js: cannot read the commit being built (git rev-parse HEAD failed) - a build must run from a checkout: ${e instanceof Error ? e.message : e}`,
      { cause: e }
    );
  }
  return (slot[STAMP_KEY] = `${Date.now()}-${commit}`);
}

/** @type {import('@sveltejs/kit/vite').Config} */
const config = {
  preprocess: vitePreprocess(),
  // SvelteKit 3 REMOVED THE IMPLICIT `$lib` and prefers `#lib` (a package.json subpath import), which
  // TypeScript resolves only with the file extension spelled out - 7645 imports in 1566 files would
  // each have to gain one. This alias is the way the removal message itself names to keep `$lib`; it
  // is deprecated (a warning at sync/dev/build); why it stays and how it goes: architecture.md, "Two build warnings".
  alias: { $lib: 'src/lib' },
  // NO PRECOMPRESS: nothing serves the result. nginx serves `build/client` from its own COPY
  // (infrastructure/local/Dockerfile.frontend) with no `gzip_static`, so every `.gz`/`.br` was
  // copied into the image and never read. Writing them all at once is also what failed: 2026-09-27
  // a local build died on `EMFILE: too many open files` over the ~4400 Noto emoji pictures.
  adapter: buildsForWeb
    ? adapterNode({ precompress: false })
    : adapterStatic({ fallback: 'index.html' }),
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
  // `pollInterval: 0` keeps SvelteKit 2's behaviour: SvelteKit 3 polls `/_app/version.json` hourly by
  // default, and the app already owns its stale-build recovery (`src/lib/utils/staleBuild.ts`), so a
  // second, unmeasured poller would be a second owner of the same question.
  version: { name: buildVersionName(), pollInterval: 0 },
  // THE WEB PAGE'S CONTENT-SECURITY-POLICY IS WRITTEN HERE, AND ONLY FOR THE WEB BUILD.
  // SvelteKit knows the one inline script it emits and hashes it; the template's own inline
  // scripts are hashed from app.html by `webDocumentCsp`. No `'unsafe-inline'` for scripts.
  // The native build gets NO kit.csp: Tauri states its own policy (src-tauri/tauri.conf.json) and
  // hashes the inline scripts of the files it embeds, and a second policy here would only narrow it.
  // The reasoning per directive is in src/lib/security/cspPolicy.js.
  ...(buildsForWeb
    ? { csp: webDocumentCsp(readFileSync(new URL('./src/app.html', import.meta.url), 'utf8')) }
    : {}),
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
};

export default config;

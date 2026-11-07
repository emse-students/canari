/**
 * The Content-Security-Policies served to this app, asserted against what the app actually does.
 *
 * THREE POLICIES, ONE DESCRIPTION (2026-10-22):
 *  - a web PAGE carries SvelteKit's (`kit.csp`, built from `cspPolicy.js`), with the hash of each
 *    inline script it holds;
 *  - every other web response carries nginx's `csp.conf` (`infrastructure/local/Dockerfile.frontend`),
 *    which must state the same directives - a worker's policy is its own response's;
 *  - the native WebView carries Tauri's (`src-tauri/tauri.conf.json`).
 *
 * It lives in the frontend suite rather than next to the Dockerfile because the thing that can
 * invalidate it is FRONTEND code: the policy is a description of which hosts the client reads
 * from, and it goes stale the moment a component calls a host nobody added to `connect-src`.
 * That failure is invisible in every gate we run - it compiles, it lints, it deploys, and only a
 * browser on the real origin refuses the request. Commenting a GIF was broken that way: the
 * picker's grid rendered (wide `img-src`) while fetching the chosen GIF's bytes was blocked
 * (narrow `connect-src`), so the feature looked alive and did nothing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceFiles } from '../../test/sourceTree';
import {
  WEB_POLICY_DIRECTIVES,
  inlineScriptHashes,
  inlineScripts,
  quoteSource,
  serializePolicy,
  webDocumentCsp,
} from './cspPolicy.js';

// Resolved from the vitest root (`frontend/`) rather than from `import.meta.url`, which vite
// serves as a non-file URL.
const DOCKERFILE = resolve(process.cwd(), '../infrastructure/local/Dockerfile.frontend');
const SRC_TAURI = resolve(process.cwd(), 'src-tauri');

const dockerfile = readFileSync(DOCKERFILE, 'utf8');
const appHtml = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');

/** One `add_header Content-Security-Policy` of the Dockerfile: the policy, and the file it writes. */
interface Declaration {
  policy: string;
  /** The snippet the `printf` writes it into, or `null` when it is inline in a location block. */
  snippet: string | null;
}

/** Every `add_header Content-Security-Policy "..."` in the Dockerfile, shell-unescaped. */
function policyDeclarations(): Declaration[] {
  return [
    ...dockerfile.matchAll(
      /add_header Content-Security-Policy "(.*?)" always;(?:\\n' > \/etc\/nginx\/snippets\/([a-z-]+\.conf))?/g
    ),
  ].map((m) => ({
    // The Dockerfile writes the config from a single-quoted shell string, so every literal
    // quote inside it is spelt `'"'"'`. Undo that to read the policy as the browser sees it.
    policy: m[1].replaceAll(`'"'"'`, `'`),
    snippet: m[2] ?? null,
  }));
}

/** The policy one snippet holds. */
function snippetPolicy(snippet: string): string {
  const found = policyDeclarations().filter((d) => d.snippet === snippet);
  expect(found, `${snippet} is declared once`).toHaveLength(1);
  return found[0].policy;
}

/** The site-wide policy: every web response that is not a page (`csp.conf`). */
const siteWide = () => snippetPolicy('csp.conf');

/** The value of one directive, as the list of sources it allows; `undefined` when absent. */
function maybeSources(policy: string, directive: string): string[] | undefined {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === directive || part.startsWith(`${directive} `));
  return found?.split(/\s+/).slice(1);
}

/** The value of one directive, which must be present. */
function sources(policy: string, directive: string): string[] {
  const found = maybeSources(policy, directive);
  expect(found, `policy has no ${directive} directive`).toBeDefined();
  return found!;
}

/** The web page's policy as SvelteKit will write it, before the start script's own hash. */
const webPagePolicy = () => serializePolicy(webDocumentCsp(appHtml).directives);

/** The native WebView's policy, from `tauri.conf.json`'s directive map (or an overlay's). */
function tauriPolicy(file = 'tauri.conf.json'): Record<string, string> {
  return JSON.parse(readFileSync(resolve(SRC_TAURI, file), 'utf8')).app.security.csp;
}

/** The native policy serialised as a header, so the same assertions read all three policies. */
const nativePolicy = () =>
  Object.entries(tauriPolicy())
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');

/** The three policies that govern scripts, by name, for the assertions every one must pass. */
const ALL_POLICIES: [string, () => string][] = [
  ['nginx csp.conf', siteWide],
  ['the web page (kit.csp)', webPagePolicy],
  ['the native WebView (tauri.conf.json)', nativePolicy],
];

describe('the served Content-Security-Policy', () => {
  it('is declared once site-wide, once for pages, and included wherever it is needed', () => {
    // nginx's add_header REPLACES the inherited set, so every block that sets a header needs the
    // policy. Verbatim copies is how one of them silently keeps an old value: this asserts there is
    // one definition per snippet and that the blocks reach it by include, never by restating it.
    //
    // ONE DECLARED EXCEPTION, and it is a narrowing, never a copy: `/adminer/` (the database admin
    // UI, 2026-10-02) states its OWN policy, because the site-wide one allows `img-src https:` and
    // `connect-src` to Klipy's GIF host - a console that shows production data must not have an
    // image beacon to send it out through if Adminer ever has an XSS. The next test holds it narrower.
    const declared = policyDeclarations();
    expect(declared.map((d) => d.snippet)).toEqual(['csp.conf', 'csp-page.conf', null]);
    expect(declared[2].policy).toContain("frame-ancestors 'none'");
    expect(dockerfile.match(/include \/etc\/nginx\/snippets\/csp\.conf;/g)?.length).toBeGreaterThan(
      1
    );
  });

  it('keeps the one exception (/adminer/) strictly narrower than the site-wide policy', () => {
    const adminer = policyDeclarations().find((d) => d.snippet === null)!.policy;
    // No host named at all, and `img-src`/`connect-src` are the page's own origin (plus data: images).
    expect(adminer).not.toMatch(/https?:/);
    expect(sources(adminer, 'img-src')).toEqual(["'self'", 'data:']);
    expect(sources(adminer, 'connect-src')).toEqual(["'self'"]);
    expect(sources(adminer, 'default-src')).toEqual(["'self'"]);
    // And it is not a copy of the wide one: everything it allows that the site-wide policy states,
    // the site-wide policy allows too. Adminer's own inline scripts are the one thing it keeps
    // (`'unsafe-inline'`): it is a third-party page, and it is not ours to hash.
    for (const directive of ['style-src', 'img-src', 'connect-src']) {
      for (const source of sources(adminer, directive)) {
        expect(sources(siteWide(), directive)).toContain(source);
      }
    }
  });

  it('states the SAME directives in nginx and in the page policy SvelteKit writes', () => {
    // A worker's policy is its own response's (nginx's), the page's is SvelteKit's: two copies of
    // one description, and the one that drifts is the one that refuses something in production.
    expect(siteWide().replace(/;$/, '')).toBe(serializePolicy({ ...WEB_POLICY_DIRECTIVES }));
  });

  it('gives a page only frame-ancestors from nginx, the one directive a <meta> cannot carry', () => {
    // A second policy is INTERSECTED with the first. csp.conf holds no script hash, so including it
    // on a page would refuse the page's own inline scripts; this one restricts nothing else.
    expect(snippetPolicy('csp-page.conf')).toBe("frame-ancestors 'none'");
  });

  it('names every external host the client reads bytes from', () => {
    const connect = sources(siteWide(), 'connect-src');
    // PostComments fetched the chosen GIF's BYTES from this host, to encrypt them before upload.
    // Since the GIF relay (2026-10-18) the current bundle reads them through chat-delivery
    // (`gifMediaProxy.ts`, `'self'`) and no longer needs it; it is KEPT, unchanged, for a web tab
    // still running an older bundle, whose comment attach would otherwise fail until it reloads.
    // Removing it is a narrowing the owner may take (docs/wiki/frontend/modules/chat.md).
    expect(connect).toContain('https://static.klipy.com');
  });

  it('does not let the browser reach the GIF SEARCH API - the server asks it (2026-10-16)', () => {
    // The search goes through chat-delivery's `/api/mls/gifs` so KLIPY never sees a reader's query,
    // IP or identifier (`gifSearch.ts`). Naming the API host again would re-open the direct path.
    expect(sources(siteWide(), 'connect-src')).not.toContain('https://api.klipy.com');
  });

  it('names no payment processor host: checkout is a navigation to the provider, never an embed', () => {
    // Stripe left the product (docs/wiki/stripe-archive.md); its hosts must not linger in the policy.
    for (const [, policy] of ALL_POLICIES) expect(policy()).not.toMatch(/stripe/i);
  });

  it("names the estate's own wss:// origins, not only 'self' (older Safari)", () => {
    // 'self' matches wss: only under CSP Level 3; a Safari before it refuses the socket otherwise.
    for (const policy of [siteWide, webPagePolicy]) {
      expect(sources(policy(), 'connect-src')).toEqual(
        expect.arrayContaining([
          'wss://canari.emse.fr',
          'wss://canari-emse.fr',
          'wss://www.canari-emse.fr',
          'wss://dev.canari-emse.fr',
        ])
      );
    }
  });

  it('never widens connect-src to a bare scheme', () => {
    // `img-src` is deliberately `https:`, because it renders arbitrary user-posted image URLs.
    // `connect-src` governs what the app may read into memory and must stay an allowlist - a
    // future host that is blocked is fixed by naming it here, never by opening the directive.
    // `ws:`/`wss:` included (2026-10-22): both WebSockets are same-origin, which `'self'` matches.
    for (const [name, policy] of ALL_POLICIES) {
      const connect = sources(policy(), 'connect-src');
      for (const bare of ['https:', 'http:', 'wss:', 'ws:', '*']) {
        expect(connect, `${name} connect-src`).not.toContain(bare);
      }
    }
  });
});

describe('no script runs unless the policy names it (2026-10-22)', () => {
  it.each(ALL_POLICIES)('%s allows no inline script and no eval', (_name, policy) => {
    for (const directive of ['script-src', 'script-src-elem', 'script-src-attr', 'default-src']) {
      const allowed = maybeSources(policy(), directive) ?? [];
      expect(allowed).not.toContain("'unsafe-inline'");
      expect(allowed).not.toContain("'unsafe-eval'");
      expect(allowed).not.toContain("'unsafe-hashes'");
      // A scheme source would allow a script from any host (`https:`) or from a string (`data:`).
      expect(allowed.filter((s) => s.endsWith(':'))).toEqual([]);
    }
  });

  it.each(ALL_POLICIES)(
    '%s compiles WebAssembly - the MLS engine needs it - and nothing else is widened',
    (_name, policy) => {
      // `WebAssembly.instantiate` of `src/lib/wasm` (and pdf.js's decoders) is refused without it,
      // and every encrypted conversation with it. It allows compiling WebAssembly, never `eval`.
      expect(sources(policy(), 'script-src').slice(0, 2)).toEqual(["'self'", "'wasm-unsafe-eval'"]);
      expect(sources(policy(), 'object-src')).toEqual(["'none'"]);
      expect(sources(policy(), 'base-uri')).toEqual(["'self'"]);
      expect(sources(policy(), 'default-src')).toEqual(["'self'"]);
    }
  );

  it('hashes every inline script app.html carries, and SvelteKit adds its own (hash mode)', () => {
    const csp = webDocumentCsp(appHtml);
    // Hash, never nonce: a page is cached at the edge for 60 s, and a nonce would be shared by
    // every visitor of that minute.
    expect(csp.mode).toBe('hash');
    // The theme, the safe-area inset, iOS Dynamic Type and the WASM preload: four scripts, four
    // hashes. A fifth script without its hash would be refused on every page, before first paint.
    const scriptCount = inlineScripts(appHtml).length;
    expect(scriptCount).toBe(4);
    const hashes = inlineScriptHashes(appHtml);
    expect(hashes).toHaveLength(scriptCount);
    expect(csp.directives['script-src']).toEqual(['self', 'wasm-unsafe-eval', ...hashes]);
  });

  it('computes the hash a browser computes: the exact text between the tags', () => {
    // sha256("alert(1)"), the value every CSP reference uses as its example.
    expect(inlineScriptHashes('<script>alert(1)</script>')).toEqual([
      'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=',
    ]);
    // Where a script ENDS is the HTML tokenizer's decision, so the parser must agree with it: an
    // end tag with a space, in capitals, or carrying junk attributes still ends the element.
    for (const end of ['</script >', '</SCRIPT>', '</script foo="bar">']) {
      expect(inlineScriptHashes(`<script>alert(1)${end}<script>x</script>`)[0]).toBe(
        'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='
      );
    }
    // A script with a src is allowed by its origin, a data block never runs: neither is hashed.
    expect(
      inlineScriptHashes(
        '<script src="/x.js"></script><script type="application/ld+json">{}</script>' +
          '<script type="application/json" id="s">{}</script>'
      )
    ).toEqual([]);
    expect(quoteSource('sha256-abc')).toBe("'sha256-abc'");
    expect(quoteSource('blob:')).toBe('blob:');
  });

  it('leaves no inline event handler in an HTML string - the policy would refuse it', () => {
    // `onerror="..."` in a string handed to innerHTML is an inline script: refused without
    // 'unsafe-inline', silently - the photo fallback of the trombinoscope export was one, and is a
    // listener now (`trombinoscope.ts`). A Svelte `onerror={...}` is compiled to a listener and is
    // not what this looks for: only TypeScript/JavaScript sources build HTML as text.
    const scanned = sourceFiles({ under: 'src', extensions: ['ts', 'js'], tests: 'exclude' });
    // The scan reads the tree it thinks it does: the file that HAD the handler is in it.
    expect(scanned.map((f) => f.path)).toContain('src/lib/utils/trombinoscope.ts');
    const offenders = scanned
      .filter((f) => /\son[a-z]+\s*=\s*\\?["']/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('the native WebView policy (tauri.conf.json, 2026-10-22)', () => {
  /** Every origin a store build may bake as its backend (`.github/scripts/lib/backend-url.sh`). */
  const BACKEND_HOSTS = [
    'canari.emse.fr',
    'canari-emse.fr',
    'www.canari-emse.fr',
    'dev.canari-emse.fr',
  ];

  it('is set at all: `null` gave any script in the WebView the whole IPC surface', () => {
    expect(tauriPolicy()).toBeTypeOf('object');
    expect(tauriPolicy()).not.toBeNull();
  });

  it("lets Tauri hash its embedded scripts, and keeps style-src's 'unsafe-inline' working", () => {
    // Tauri adds the hash of every inline script of the files it embeds to script-src - that is
    // what allows app.html's four scripts and SvelteKit's start script. It would add the hashes of
    // inline <style> elements to style-src as well, and a hash in a source list makes the browser
    // IGNORE 'unsafe-inline' there - every Svelte `style=` attribute refused. So that one directive,
    // and only that one, is left alone.
    const security = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8')).app
      .security;
    expect(security.dangerousDisableAssetCspModification).toEqual(['style-src']);
    expect(sources(nativePolicy(), 'style-src')).toContain("'unsafe-inline'");
  });

  it('reaches the IPC bridge and every backend a store build may bake', () => {
    const connect = sources(nativePolicy(), 'connect-src');
    // Tauri's own bridge: `ipc:` on Apple platforms, `http://ipc.localhost` on Android and Windows.
    expect(connect).toEqual(expect.arrayContaining(['ipc:', 'http://ipc.localhost', 'blob:']));
    // A read from the API goes through the WebView's own fetch (`fetchRouting.ts`), and the call
    // signalling socket is the WebView's (`CallService.ts`).
    for (const host of BACKEND_HOSTS) {
      expect(connect).toContain(`https://${host}`);
      expect(connect).toContain(`wss://${host}`);
      expect(sources(nativePolicy(), 'media-src')).toContain(`https://${host}`);
    }
  });

  it('names no plaintext origin in a release build - only the local overlay may', () => {
    for (const [name, value] of Object.entries(tauriPolicy())) {
      expect(value, name).not.toMatch(/(^|\s)(http|ws):(\s|$)/);
      expect(value.replace('http://ipc.localhost', ''), name).not.toMatch(/(^|\s)(http|ws):\/\//);
    }
  });

  it('widens the local overlay, never narrows it: every release source stays in it', () => {
    // tauri.local.conf.json is merged over this file (and read verbatim by ios.yml's local-device
    // build): a directive it restates replaces the release one, so it must keep every source.
    const local = tauriPolicy('tauri.local.conf.json');
    const release = tauriPolicy();
    for (const [name, value] of Object.entries(local)) {
      const localSources = value.split(/\s+/);
      for (const source of release[name].split(/\s+/)) expect(localSources, name).toContain(source);
    }
    expect(local['connect-src'].split(/\s+/)).toEqual(expect.arrayContaining(['http:', 'ws:']));
  });

  it('keeps the dev policy as strict for scripts, and lets `tauri dev` reach its Vite server', () => {
    const security = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8')).app
      .security;
    const dev: Record<string, string> = security.devCsp;
    const script = dev['script-src'].split(/\s+/);
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    // Vite's hot reload is a WebSocket to the dev server (`devUrl`, port 1420).
    expect(dev['connect-src'].split(/\s+/)).toEqual(
      expect.arrayContaining(['ws://localhost:1420', 'ws://127.0.0.1:1420'])
    );
  });

  it('ships the policy on iOS too, which is why the app needs iOS 16 (owner decision 2026-10-22)', () => {
    // WebKit before 16 does not know 'wasm-unsafe-eval' and refuses WebAssembly under any policy
    // without 'unsafe-eval': the MLS engine would not load. So no iOS override may remove the
    // policy, and every place that states the app's minimum iOS says 16.
    expect(existsSync(resolve(SRC_TAURI, 'tauri.ios.conf.json'))).toBe(false);
    const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, 'tauri.conf.json'), 'utf8'));
    expect(conf.bundle.iOS.minimumSystemVersion).toBe('16.0');
    const apple = resolve(SRC_TAURI, 'gen/apple');
    expect(readFileSync(resolve(apple, 'project.yml'), 'utf8')).toMatch(/iOS: 16\.0/);
    expect(readFileSync(resolve(apple, 'Podfile'), 'utf8')).toContain("platform :ios, '16.0'");
    const targets = [
      ...readFileSync(resolve(apple, 'canari.xcodeproj/project.pbxproj'), 'utf8').matchAll(
        /IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g
      ),
    ].map((m) => Number(m[1]));
    expect(targets.length).toBeGreaterThan(0);
    // EVERY target at 16, the extensions included. An extension whose minimum is above the phone's
    // iOS is simply not run there - no error anywhere - so the notification extension's old 18.2 left
    // every iPhone on 16.0-18.1 with the server's generic banner (P1 of 2026-11-01).
    expect(new Set(targets)).toEqual(new Set([16]));
  });

  it('gives no remote origin access to the IPC: no capability declares `remote`', () => {
    // A capability without `remote` applies to the app's own embedded pages only. One with
    // `remote.urls` would hand every Tauri command it grants to a page served from the network.
    for (const file of readdirSync(resolve(SRC_TAURI, 'capabilities'))) {
      if (!file.endsWith('.json')) continue;
      const capability = JSON.parse(readFileSync(resolve(SRC_TAURI, 'capabilities', file), 'utf8'));
      expect(capability.remote, file).toBeUndefined();
    }
  });
});

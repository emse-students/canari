import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MOBILE_APP_PACKAGE, OIDC_MOBILE_REDIRECT_URI } from './appSiteAssociation';

/**
 * THE CUSTOM SCHEME THE LOGIN COMES BACK ON MUST BE ONE THE APP ACTUALLY REGISTERS.
 *
 * WHAT THIS COST. On 2026-09-06 a TestFlight tester on the pre-release build could not log in at
 * all: Authentik answered `400` on `/application/o/authorize/` and the app showed "Redirect URI
 * Error". The `Canari Dev` OIDC provider had been configured with `fr.emse.canari.dev://callback` -
 * a scheme NOTHING in this repository declares. `tauri.conf.json` has identifier `fr.emse.canari`
 * and the deep-link plugin registers that one scheme, so the provider was waiting for a callback no
 * build could ever send. Somebody wrote a `.dev` scheme into the IdP expecting the app to follow it,
 * and nothing anywhere disagreed.
 *
 * WHAT IT ASSERTS. `oidcRedirectUri()` in `$lib/stores/auth.ts` returns `OIDC_MOBILE_REDIRECT_URI`
 * on mobile, derived from the identifier in `$lib/mobile/appSiteAssociation.ts`. That URI must
 * appear in `plugins.deep-link.mobile` of `tauri.conf.json`, with that exact host. A scheme the OS never routes is a login that dead-ends
 * on the device, and the runtime symptom names the IdP rather than the app - which is why it reads
 * as a server fault and gets diagnosed on the wrong box.
 *
 * IT IS READ FROM THE SOURCE, deliberately: the branch is behind `isMobileTauriRuntime()`, so
 * calling the function under vitest takes the web path and proves nothing about the mobile one.
 *
 * ## THE HALF THIS TEST DOES NOT COVER, AND CANNOT
 *
 * **It cannot see Authentik's database.** The provider's authorized redirect URIs live in
 * Authentik's Postgres on the `miconnect` box, outside this repository and outside every gate in
 * it. This test proves the app asks for a scheme it registers; it says NOTHING about whether the
 * IdP will accept that scheme. That half is protected only by
 * `docs/wiki/infrastructure/authentik.md` - "The three Canari providers" and the hand-mutation
 * section under it - and a restore from an older backup silently undoes it. If this test is green
 * and a tester still sees "Redirect URI Error", the provider is what to read.
 */
const here = dirname(fileURLToPath(import.meta.url));
const AUTH_STORE = resolve(here, '../stores/auth.ts');
const TAURI_CONF = resolve(here, '../../../src-tauri/tauri.conf.json');

/** `{ scheme, host }` pairs the deep-link plugin registers for mobile, custom schemes only. */
function declaredMobileLinks(): { scheme: string; host: string }[] {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as {
    plugins?: { 'deep-link'?: { mobile?: { scheme?: string[]; host?: string }[] } };
  };
  const mobile = conf.plugins?.['deep-link']?.mobile ?? [];
  const out: { scheme: string; host: string }[] = [];
  for (const entry of mobile) {
    if (!entry.host) continue;
    for (const scheme of entry.scheme ?? []) {
      // `https` entries are App Links / Universal Links, matched on a real domain - not a scheme a
      // redirect URI can name here.
      if (scheme === 'https' || scheme === 'http') continue;
      out.push({ scheme, host: entry.host });
    }
  }
  return out;
}

/** The body of `oidcRedirectUri()` in `auth.ts`, read from the source. */
function oidcRedirectUriBody(): string {
  const src = readFileSync(AUTH_STORE, 'utf8');
  const start = src.indexOf('function oidcRedirectUri()');
  expect(
    start,
    'oidcRedirectUri() was renamed or removed - this test anchors on it'
  ).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end, 'could not find the end of oidcRedirectUri()').toBeGreaterThan(start);
  return src.slice(start, end);
}

const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { identifier?: string };

describe('the OIDC redirect scheme is one the app registers', () => {
  it('oidcRedirectUri() returns the shared constant and spells no scheme of its own', () => {
    // A literal in the function would be a second copy this file no longer reads.
    const body = oidcRedirectUriBody();
    expect(body).toContain('OIDC_MOBILE_REDIRECT_URI');
    const literals = [...body.matchAll(/'([a-z][a-z0-9.+-]*):\/\//gi)].filter(
      (m) => m[1] !== 'http' && m[1] !== 'https'
    );
    expect(literals.map((m) => m[0])).toEqual([]);
  });

  it('declares the scheme:host it returns in tauri.conf.json deep-link mobile', () => {
    const declaredKeys = new Set(declaredMobileLinks().map((d) => `${d.scheme}://${d.host}`));
    expect(
      declaredKeys.has(OIDC_MOBILE_REDIRECT_URI),
      `oidcRedirectUri() returns ${OIDC_MOBILE_REDIRECT_URI}, which tauri.conf.json does not register. ` +
        `Declared: ${[...declaredKeys].join(', ')}. The OS will never route this back to the ` +
        `app, and the IdP reports it as "Redirect URI Error" - see ` +
        `docs/wiki/infrastructure/authentik.md.`
    ).toBe(true);
  });

  it('returns a callback host, not some other deep link', () => {
    expect(OIDC_MOBILE_REDIRECT_URI.endsWith('://callback')).toBe(true);
  });

  it('uses the app identifier as its scheme, so dev and prod builds share it', () => {
    // The dev and prod builds differ by client_id and API URL, NEVER by identifier: a separate
    // `.dev` scheme would need its own bundle id, provisioning profile and store record. This
    // pins that decision, which is the one the 2026-09-06 outage was made of.
    expect(MOBILE_APP_PACKAGE).toBe(conf.identifier);
    expect(OIDC_MOBILE_REDIRECT_URI.split('://')[0]).toBe(conf.identifier);
  });
});

describe('the identifier is spelled once in the frontend source', () => {
  it('no other module writes it as a literal', () => {
    // The scheme is derived from MOBILE_APP_PACKAGE so a second package id is one change. A literal
    // elsewhere is a deep link that would keep pointing at the old app. Comments and tests are
    // allowed to name it.
    const SRC = resolve(here, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'paraglide' && e.name !== 'wasm' && e.name !== 'proto') walk(full);
          continue;
        }
        if (!/\.(ts|svelte)$/.test(e.name) || e.name.endsWith('.test.ts')) continue;
        if (full.endsWith(join('mobile', 'appSiteAssociation.ts'))) continue;
        const code = readFileSync(full, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n');
        if (/fr\.emse\.canari(:\/\/|:?['"`])/.test(code) || /id=fr\.emse\.canari/.test(code)) {
          offenders.push(relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

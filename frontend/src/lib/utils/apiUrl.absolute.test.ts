import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No `fetch` may address the API with a RELATIVE path - it is dead on mobile, and it lies.
 *
 * In the browser the app is served from the same origin as nginx, so `fetch('/api/…')` works and
 * every gate stays green. In the Tauri WebView the origin is `tauri.localhost`, served by the
 * embedded asset server, so the same call never leaves the device: Tauri resolves it as an ASSET,
 * fails to find it, and falls back to `index.html`. Observed on a real phone (A1, 2026-08-11):
 *
 *   [tauri::manager] Asset `api/mls/security/pin-status/<hash>` not found; fallback to index.html
 *
 * The failure mode is what makes this worth a test rather than a review note. The call does not
 * throw and does not 404 - it resolves **200 with an HTML body**, so `res.ok` is `true`. One of the
 * three call sites this test was written for (`handlePinReset`) read exactly that flag to decide the
 * server had wiped the PIN verifier, and went on to wipe the device's local MLS state: a destructive
 * action gated on a success that never happened, losing that device's encrypted history while the
 * server-side verifier stayed registered. Same family as WP-DIRECTBOOT-1 - a "cannot read" mistaken
 * for a "not there", with the destructive branch behind it.
 *
 * The base URLs come from `apiUrl.ts` (`coreUrl`, `socialUrl`, `gatewayUrl`, `deliveryUrl`) or from
 * `historyBaseUrl`, which is `VITE_DELIVERY_URL` inlined - all four builds set the vars, so on mobile
 * they resolve absolute and in the browser they fall back to the origin, which is the old behaviour.
 *
 * `socialUrl()` deliberately returns an EMPTY string when unset, so `${socialUrl()}/api/posts` is a
 * relative path by design in the browser. That is why this test matches on the LITERAL slash-api
 * opening a fetch argument and not on the resulting string: a template whose first segment is a base
 * expression is exactly the correct form, whatever it evaluates to.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');

/** `fetch('/api/…')` / `fetch("/api/…")` / `fetch(`/api/…`)`, with any whitespace after the paren. */
const RELATIVE_API_FETCH = /\bfetch\(\s*[`'"]\/api\//;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'paraglide' || entry === 'node_modules') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('API calls are addressed absolutely', () => {
  it('has no fetch() to a relative /api/ path anywhere in src', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => RELATIVE_API_FETCH.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));

    expect(
      offenders,
      `Use a base from $lib/utils/apiUrl (coreUrl/socialUrl/gatewayUrl/deliveryUrl) or ` +
        `historyBaseUrl. A relative /api/ path resolves to the Tauri asset server on mobile and ` +
        `returns index.html with status 200, so res.ok is true and the response is HTML.`
    ).toEqual([]);
  });
});

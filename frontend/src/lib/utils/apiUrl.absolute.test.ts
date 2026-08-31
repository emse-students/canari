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

/**
 * `src="/api/…"` and `src={`/api/…`}` - the same defect one element over, and QUIETER.
 *
 * A `fetch` at least returns something a caller can misread; an `<img>` pointed at the Tauri asset
 * server is handed `index.html`, fails to decode, fires `onerror`, and a component with an initials
 * placeholder shows the placeholder. Nothing is thrown and nothing is logged. That is how the Carte
 * de la Vie Asso shipped with every president photo and every association logo missing on mobile.
 *
 * The fix is `apiAssetUrl()`, which leaves an already-absolute URL (including `data:` and `blob:`)
 * exactly as it is.
 */
const RELATIVE_API_SRC = /\bsrc=[{]?\s*[`'"]\/api\//;

/**
 * The same defect one INDIRECTION over, and the one the two checks above cannot see.
 *
 * `setCardIcon` and the logo endpoints store their result as the app-relative
 * `/api/media/public/<mediaId>?v=...`, so the offending string never appears in the source at all -
 * it arrives at runtime in a field and is bound as `src={card.iconUrl}`. There is no literal `/api/`
 * to match and no `fetch` to inspect, and on mobile the result is exactly the silent placeholder
 * described above. That is how `CardTile` shipped with every partner logo and every product icon
 * missing in the Tauri builds while both checks above stayed green.
 *
 * So the field NAMES the backend stores such a path under are the thing to guard: a binding of one
 * must route through an absolutizer - `apiAssetUrl` or `associationLogoSrc` - and never reach `src`
 * raw. Wrapping the field in a call is what makes a site pass, because the absolutizer's name then
 * sits between `src={` and the field.
 */
const RAW_STORED_ASSET_SRC =
  /\bsrc=\{\s*[A-Za-z_$][\w$]*(?:\s*[?.]*\.\s*[\w$]+)*\.(?:iconUrl|logoUrl)\b|\bsrc=\{\s*(?:iconUrl|logoUrl)\b/;

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

  it('has no element src pointing at a relative /api/ path anywhere in src', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => RELATIVE_API_SRC.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));

    expect(
      offenders,
      `Wrap the path in apiAssetUrl() from $lib/utils/apiUrl. On mobile a relative /api/ src is ` +
        `served index.html by the Tauri asset server: the image fails to decode, onerror fires, and ` +
        `a component with a placeholder shows the placeholder forever - silently.`
    ).toEqual([]);
  });

  it('never binds a stored iconUrl/logoUrl field straight into a src attribute', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => RAW_STORED_ASSET_SRC.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));

    expect(
      offenders,
      `The backend stores iconUrl/logoUrl as the app-relative /api/media/public/<id>, so binding ` +
        `one raw breaks it on mobile with no literal /api/ in the source for the checks above to ` +
        `catch. Pass it through apiAssetUrl() (or associationLogoSrc()) first.`
    ).toEqual([]);
  });
});

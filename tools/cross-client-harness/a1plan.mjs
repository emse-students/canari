/**
 * WHAT AN A1 APK BUILD MUST BE FOR THE ESTATE `SITE` NAMES - the decisions of `a1apk.mjs`, pure.
 *
 * Until 2026-10-24 the APK gesture knew ONE estate, the local one: it reverse-forwarded `SITE`'s port
 * over the USB cable, compiled the `local-estate` capability overlay in, and refused any `SITE` with
 * no explicit port - so `https://dev.canari-emse.fr`, the 1.4.1 campaign's target, could not be built
 * for at all (R2 of that campaign's plan). Dev differs on every one of those decisions:
 *
 * - **No `adb reverse`.** Dev is a public `https://` origin the phone reaches over its own radios;
 *   there is no workstation port to map, and the old refusal of a default-port `SITE` was a
 *   consequence of assuming there always was one.
 * - **No `local-estate` overlay.** `tauri.conf.json`'s default capability scope is `https://**` and its
 *   CSP already names `dev.canari-emse.fr`, so the build a tester's pre-release ships is the shape this
 *   one takes; compiling the overlay in would widen the scope to `http:` for no reason.
 * - **The identity provider is dev's.** The local estate authenticates against the values in the
 *   generated `frontend/.env`; dev has its own Authentik client, which the pre-release pipeline takes
 *   from the `DEV_AUTHENTIK_*` secrets (`android.yml`). The rig reads the same two values from the
 *   machine-local `names.mjs` (`DEV_AUTHENTIK`), and REFUSES without them: there is no fallback from
 *   dev's set to the local one, as there is none in the pipeline.
 * - **`VITE_DEPLOY_ENVIRONMENT=development`**, the banner every dev build carries.
 *
 * Production has no plan: `estateOf` refuses it before anything here runs.
 *
 * Pure, so `archive/a1plan-selftest.mjs` pins every decision in CI.
 */
import { PRODUCTION_APP_HOSTS, estateOf } from './estate-target.mjs';

/** The capability overlay that lets a build reach a plain-`http` local estate. Relative to `frontend/`. */
export const LOCAL_OVERLAY = 'src-tauri/tauri.local.conf.json';

/** The seven origins Vite bakes in, all set to the estate's origin. */
export const VITE_ORIGIN_KEYS = [
  'VITE_FRONTEND_URL',
  'VITE_GATEWAY_URL',
  'VITE_DELIVERY_URL',
  'VITE_MEDIA_URL',
  'VITE_CALL_URL',
  'VITE_SOCIAL_URL',
  'VITE_CORE_URL',
];

/**
 * The workstation port `adb reverse` maps for `site`, or null when the estate is reached over the
 * phone's radios (dev).
 *
 * THE DEFAULT PORT IS A PORT. `new URL('http://localhost').port` is the empty string, and the old
 * refusal read that as "no port"; the reverse maps the port the scheme implies.
 */
export function reversePortFor(site) {
  if (estateOf(site) !== 'local') return null;
  const url = new URL(site);
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * The build an estate needs.
 *
 * @param {object} p
 * @param {string} p.site `SITE`
 * @param {boolean} [p.release] the minified build of check R (costs the device; local or dev alike)
 * @param {{url?: string, clientId?: string}} [p.devAuthentik] dev's identity-provider values, required for dev
 * @returns {{estate: 'local'|'dev', origin: string, reversePort: string|null, overlay: string|null,
 *   args: string[], env: Record<string,string>, authentikFromFrontendEnv: boolean}}
 */
export function a1BuildPlan({ site, release = false, devAuthentik } = {}) {
  const estate = estateOf(site);
  const origin = new URL(site).origin;
  const env = Object.fromEntries(VITE_ORIGIN_KEYS.map((k) => [k, origin]));
  const base = release ? ['android', 'build'] : ['android', 'build', '--debug'];

  if (estate === 'local') {
    return {
      estate,
      origin,
      reversePort: reversePortFor(site),
      overlay: LOCAL_OVERLAY,
      args: [...base, '--config', LOCAL_OVERLAY],
      env,
      authentikFromFrontendEnv: true,
    };
  }

  const idpUrl = devAuthentik?.url;
  const clientId = devAuthentik?.clientId;
  if (!(typeof idpUrl === 'string' && /^https:\/\/\S+$/.test(idpUrl)) || !(typeof clientId === 'string' && /^[A-Za-z0-9._-]+$/.test(clientId))) {
    throw new Error(
      'a dev APK needs dev\'s identity-provider values and names.mjs exports no usable DEV_AUTHENTIK ' +
        '({ url: "https://...", clientId: "..." }) - the pre-release pipeline takes them from the ' +
        'DEV_AUTHENTIK_* secrets, and there is no fallback to the local estate\'s set.',
    );
  }
  return {
    estate,
    origin,
    reversePort: null,
    overlay: null,
    args: base,
    env: { ...env, VITE_AUTHENTIK_URL: idpUrl, VITE_AUTHENTIK_CLIENT_ID: clientId, VITE_DEPLOY_ENVIRONMENT: 'development' },
    authentikFromFrontendEnv: false,
  };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A production APPLICATION origin as it would appear baked in: a scheme, then the bare host. */
const PRODUCTION_ORIGIN_SOURCE = `(?:https|wss)://(?:${PRODUCTION_APP_HOSTS.map(escape).join('|')})(?![\\w.-])`;
const PRODUCTION_ORIGIN = new RegExp(PRODUCTION_ORIGIN_SOURCE);

/** The source module whose two constants are production NAMES the app RECOGNISES, never calls. Relative to `frontend/`. */
export const LINK_MODULE = 'src/lib/utils/publicAppUrl.ts';

/**
 * The production origins `publicAppUrl.ts` declares as LINK constants - read from the source of the
 * tree being built, so the allowance follows the code instead of a copy of it.
 *
 * WHY THEY ARE IN EVERY BUNDLE, dev included (measured 2026-10-24 on the first dev APK build, chunk
 * `Dypz5d_W.js`): `DEFAULT_PUBLIC_APP_ORIGIN` is what `publicAppOrigin()` mints share links with when
 * the build baked NO `VITE_FRONTEND_URL` (a dev build bakes dev's, so it never reaches it), and the
 * base `isPublicAppUrl`/`inAppPathFromHref` resolve a relative href against when there is no
 * `window`; `LEGACY_PUBLIC_APP_ORIGIN` is only COMPARED against. Neither opens a connection: every
 * request the app makes goes to a `VITE_*_URL`, and `buildEnvVerdict` proves those are the estate's.
 *
 * NO FALLBACK: a source that no longer declares them throws, rather than allowing nothing or anything.
 *
 * @param {string} source the text of `LINK_MODULE`
 * @returns {string[]}
 */
export function linkOriginsOf(source) {
  const found = [...source.matchAll(/export const (?:DEFAULT|LEGACY)_PUBLIC_APP_ORIGIN = '([^']+)'/g)].map((m) => m[1]);
  if (found.length !== 2 || !found.every((o) => PRODUCTION_ORIGIN.test(o))) {
    throw new Error(`${LINK_MODULE} no longer declares its two production link origins as expected (found ${JSON.stringify(found)}) - re-read it before allowing anything`);
  }
  return found;
}

/**
 * Whether a packaged bundle targets `origin` AND NOTHING ELSE that is production.
 *
 * Two questions, because the old check asked only the first: a bundle that mentions the estate can
 * still carry a production origin beside it (an env var Vite took from a stale `frontend/.env`), and
 * an APK talking to both is an APK on production.
 *
 * ONE NARROW ALLOWANCE (`linkOriginsOf`): a production origin that is EXACTLY one of the link
 * constants, as a whole string literal (optionally with the one trailing `/` the module appends), is
 * a name the app recognises. A socket (`wss://`), a path, a port, or any origin that is not a
 * whole literal is still refused - and the build ENVIRONMENT, the only way a production origin could
 * become a request target, is checked at its source by `buildEnvVerdict`.
 *
 * @param {{name: string, text: string}[]} chunks the packaged JS chunks
 * @param {string} origin the estate's origin
 * @param {string[]} [linkOrigins] from `linkOriginsOf`; none allowed when absent
 */
export function bundleTargetVerdict(chunks, origin, linkOrigins = []) {
  const hits = chunks.filter((c) => c.text.includes(origin)).map((c) => c.name);
  const all = new RegExp(PRODUCTION_ORIGIN_SOURCE, 'g');
  const production = [];
  const links = [];
  for (const c of chunks) {
    for (const m of c.text.matchAll(all)) {
      const before = c.text[m.index - 1];
      let end = m.index + m[0].length;
      if (c.text[end] === '/') end++;
      const isWholeLiteral = ['"', "'", '`'].includes(before) && c.text[end] === before;
      if (isWholeLiteral && linkOrigins.includes(m[0])) links.push(`${c.name}: ${c.text.slice(m.index, end)}`);
      else production.push(`${c.name}: ${c.text.slice(m.index, Math.min(c.text.length, end + 20))}`);
    }
  }
  return { ok: hits.length > 0 && production.length === 0, hits, production, links };
}

/**
 * Whether anything Vite will read as a `VITE_*` value names a production application host.
 *
 * Vite takes `VITE_*` from the process environment AND from `frontend/.env`, `.env.local`,
 * `.env.<mode>`, `.env.<mode>.local`. The plan overrides the seven origins, but any OTHER key a
 * file carries is baked as it stands - `VITE_AUTHENTIK_REDIRECT_URI` naming production would send a
 * dev sign-in back to production. Checked at the source, before the build, because the bundle cannot
 * tell a baked request target from a link constant.
 *
 * @param {Record<string,string|undefined>} env the environment the build is spawned with (plan applied)
 * @param {{name: string, text: string}[]} envFiles the `.env*` files present in the built frontend
 * @returns {{ok: boolean, offenders: string[]}}
 */
export function buildEnvVerdict(env, envFiles = []) {
  const offenders = [];
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('VITE_') && typeof v === 'string' && PRODUCTION_ORIGIN.test(v)) offenders.push(`environment ${k}`);
  }
  for (const f of envFiles) {
    for (const line of f.text.split(/\r?\n/)) {
      const m = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=\s*(.*)$/);
      // A key the environment sets wins over the file in Vite, so only an UNOVERRIDDEN line bakes.
      if (m && !(m[1] in env) && PRODUCTION_ORIGIN.test(m[2])) offenders.push(`${f.name} ${m[1]}`);
    }
  }
  return { ok: offenders.length === 0, offenders };
}

/** A git ref `--ref` may name: a tag or a branch-like name, never an option or a path. */
export const isBuildableRef = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..');

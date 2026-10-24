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

/**
 * A production APPLICATION origin as it could appear baked in, in ANY spelling a request could use:
 * `http`, `https`, `ws`, `wss` or protocol-relative `//`, any case, an optional trailing dot on the
 * host (R2 review, 2026-10-24 - the first version knew `https`/`wss` in lower case only).
 */
const PRODUCTION_ORIGIN_SOURCE = `(?:(?:https?|wss?):)?//(?:${PRODUCTION_APP_HOSTS.map(escape).join('|')})\\.?(?![\\w.-])`;
const PRODUCTION_ORIGIN = new RegExp(PRODUCTION_ORIGIN_SOURCE, 'i');

/** The source module that declares the production LINK constants. Relative to `frontend/`. */
export const LINK_MODULE = 'src/lib/utils/publicAppUrl.ts';

/**
 * What identifies `LINK_MODULE` in the source of the tree being built: its two production origin
 * constants, and its `PUBLIC_APP_HOSTS` array (whose literal survives minification as a sequence of
 * strings, which is how its CHUNK is found in a bundle).
 *
 * WHAT THE CONSTANTS ARE, AND WHAT THEY ARE NOT. `DEFAULT_PUBLIC_APP_ORIGIN` mints share links when
 * the build baked no `VITE_FRONTEND_URL`, and is the base a relative href resolves against with no
 * `window`; `LEGACY_PUBLIC_APP_ORIGIN` is compared against. **They are NOT guaranteed never to be a
 * request target** (R2 review): until #2385 the root layout started the push service with
 * `historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN`, a dead but real production fallback - so a tag
 * built with `--ref` from before #2385 carries it. That use goes through an imported BINDING, which
 * no bundle scan can see; it is removed in the product, not tolerated here.
 *
 * NO FALLBACK: a source that does not declare both constants and the array throws. A tag older than
 * the constants (`canari.emse.fr` became canonical on 2026-09-25) therefore cannot be built with
 * this check, and that is said rather than allowed.
 *
 * @param {string} source the text of `LINK_MODULE`
 * @returns {{origins: string[], hosts: string[]}}
 */
export function linkModuleOf(source) {
  const origins = [...source.matchAll(/export const (?:DEFAULT|LEGACY)_PUBLIC_APP_ORIGIN = '([^']+)'/g)].map((m) => m[1]);
  const hostsMatch = source.match(/export const PUBLIC_APP_HOSTS = \[([^\]]+)\]/);
  const hosts = hostsMatch ? [...hostsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  if (origins.length !== 2 || !origins.every((o) => PRODUCTION_ORIGIN.test(o)) || hosts.length === 0) {
    throw new Error(
      `${LINK_MODULE} does not declare its two production link origins and PUBLIC_APP_HOSTS as expected ` +
        `(origins ${JSON.stringify(origins)}, hosts ${JSON.stringify(hosts)}) - a tag older than them cannot be ` +
        'checked this way; re-read the module before allowing anything'
    );
  }
  const defaultOrigin = source.match(/export const DEFAULT_PUBLIC_APP_ORIGIN = '([^']+)'/)[1];
  const legacyOrigin = source.match(/export const LEGACY_PUBLIC_APP_ORIGIN = '([^']+)'/)[1];
  return { origins, hosts, defaultOrigin, legacyOrigin };
}

/** The root layout, relative to `frontend/` - where the dead push fallback lived until #2385. */
export const LAYOUT_MODULE = 'src/routes/+layout.svelte';

/**
 * Whether a tree's root layout still starts the push service with the production fallback
 * `historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN` - true of every tag before #2385, false after.
 * `--accept-dead-production-literal` is refused for a tree where this is false: there is nothing to
 * accept, so the flag could only ever widen the check.
 *
 * @param {string} layoutSource the text of `LAYOUT_MODULE`
 */
export const carriesDeadPushFallback = (layoutSource) => /historyBaseUrl\s*\|\|\s*DEFAULT_PUBLIC_APP_ORIGIN\b/.test(layoutSource);

/**
 * THE TWO DEAD LITERALS `--accept-dead-production-literal` MAY ADMIT, by the name each is recorded
 * under, and the exact compiled shape of each (decided 2026-10-24 for ADM-5..7). Each is admitted
 * AT MOST ONCE per bundle; a second occurrence, or any other shape, is production as before.
 *
 * - `push-service-fallback`: the canonical origin as a whole literal right after `.historyBaseUrl||`
 *   and right before the `,` ending `startPushService`'s first argument (the layout, before #2385).
 *   Unreachable in a signed-in build, where `historyBaseUrl` is always set.
 * - `legacy-apex-comparison`: the legacy origin as a whole literal right after `!==` and right before
 *   the `?` of the conditional (`seo/site.ts` comparing the baked origin with the legacy apex, before
 *   #2385). A comparison, never a request target.
 *
 * Each test takes the text, the literal's `[start, end)` (inside its quotes) and the link origins.
 */
export const DEAD_LITERAL_SHAPES = {
  'push-service-fallback': (text, start, end, link) =>
    text.slice(start, end) === link.defaultOrigin && text.slice(0, start - 1).endsWith('.historyBaseUrl||') && text[end + 1] === ',',
  'legacy-apex-comparison': (text, start, end, link) =>
    text.slice(start, end) === link.legacyOrigin && text.slice(0, start - 1).endsWith('!==') && text[end + 1] === '?',
};

/**
 * The ONE packaged chunk that is `LINK_MODULE`, found by its `PUBLIC_APP_HOSTS` array literal
 * (the hosts in order, as minified string literals with any quote). Exactly one, or a throw: two
 * would mean the allowance could not say which file it is about, none that the module moved.
 *
 * @param {{name: string, text: string}[]} chunks
 * @param {string[]} hosts from `linkModuleOf`
 * @returns {string} the chunk's name
 */
export function linkChunkOf(chunks, hosts) {
  const q = `["'\`]`;
  const array = new RegExp(`\\[${hosts.map((h) => `${q}${escape(h)}${q}`).join('\\s*,\\s*')}\\]`);
  const found = chunks.filter((c) => array.test(c.text)).map((c) => c.name);
  if (found.length !== 1) {
    throw new Error(`the bundle holds ${found.length} chunk(s) carrying ${LINK_MODULE}'s PUBLIC_APP_HOSTS (${found.join(', ') || 'none'}) - expected exactly one`);
  }
  return found[0];
}

/**
 * Whether a packaged bundle targets `origin` AND NOTHING ELSE that is production.
 *
 * Two questions, because the old check asked only the first: a bundle that mentions the estate can
 * still carry a production origin beside it (an env var Vite took from a stale `frontend/.env`), and
 * an APK talking to both is an APK on production.
 *
 * ONE NARROW ALLOWANCE: inside `LINK_MODULE`'s own chunk ONLY, an occurrence that is EXACTLY one of
 * its two declared constants, as a whole string literal (optionally `/`-terminated, the base the
 * module builds). The same literal in ANY other chunk, a socket, a path, another scheme or case, a
 * trailing dot, or a concatenation is refused. The bundle cannot see a constant used through an
 * imported binding - that is why the build ENVIRONMENT is checked at its source too
 * (`buildEnvVerdict`) and why the one such use was removed from the product (#2385).
 *
 * ONE EXPLICIT ACCEPTANCE, for old refs only (`--accept-dead-production-literal`, decided
 * 2026-10-24 for the floor/old-client rows ADM-5..7): `acceptDeadLiterals` lets through at most ONE
 * occurrence of each shape in {@link DEAD_LITERAL_SHAPES} and nothing else - every other production
 * spelling, in every chunk, stays refused. It is never implied.
 *
 * @param {{name: string, text: string}[]} chunks every packaged JS file (chunks, nodes, entry)
 * @param {string} origin the estate's origin
 * @param {{origins: string[], chunk: string, defaultOrigin?: string, legacyOrigin?: string} | null} [link] the link constants and their chunk; none allowed when null
 * @param {{acceptDeadLiterals?: boolean}} [options]
 * @returns accepted entries read `<shape name> <chunk>: <context>`
 */
export function bundleTargetVerdict(chunks, origin, link = null, { acceptDeadLiterals = false } = {}) {
  if (acceptDeadLiterals && !(link?.defaultOrigin && link?.legacyOrigin)) {
    throw new Error("bundleTargetVerdict: accepting the dead literals needs the link module's DEFAULT and LEGACY origins");
  }
  const used = new Set();
  const hits = chunks.filter((c) => c.text.includes(origin)).map((c) => c.name);
  const all = new RegExp(PRODUCTION_ORIGIN_SOURCE, 'gi');
  const production = [];
  const links = [];
  const accepted = [];
  for (const c of chunks) {
    for (const m of c.text.matchAll(all)) {
      const before = c.text[m.index - 1];
      let end = m.index + m[0].length;
      if (c.text[end] === '/') end++;
      const isWholeLiteral = ['"', "'", '`'].includes(before) && c.text[end] === before;
      const isLink = link !== null && c.name === link.chunk && isWholeLiteral && link.origins.includes(m[0]);
      const shape =
        !isLink && acceptDeadLiterals && isWholeLiteral
          ? Object.keys(DEAD_LITERAL_SHAPES).find((n) => !used.has(n) && DEAD_LITERAL_SHAPES[n](c.text, m.index, end, link))
          : undefined;
      if (isLink) links.push(`${c.name}: ${c.text.slice(m.index, end)}`);
      else if (shape) {
        used.add(shape);
        accepted.push(`${shape} ${c.name}: ${c.text.slice(Math.max(0, m.index - 19), end + 2)}`);
      }
      else production.push(`${c.name}: ${c.text.slice(m.index, Math.min(c.text.length, end + 20))}`);
    }
  }
  return { ok: hits.length > 0 && production.length === 0, hits, production, links, accepted };
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
      // `export VITE_X=` is dotenv syntax Vite reads too (R2 review).
      const m = line.match(/^\s*(?:export\s+)?(VITE_[A-Z0-9_]+)\s*=\s*(.*)$/);
      // A key the environment sets wins over the file in Vite, so only an UNOVERRIDDEN line bakes.
      if (m && !(m[1] in env) && PRODUCTION_ORIGIN.test(m[2])) offenders.push(`${f.name} ${m[1]}`);
    }
  }
  return { ok: offenders.length === 0, offenders };
}

/**
 * Whether the APK at hand may be INSTALLED on this estate without a build in this run (`--no-build`).
 *
 * The bundle cannot be re-read from the APK: Tauri embeds the frontend brotli-compressed inside the
 * native library (`lib/<abi>/lib*_app_lib.so`); there is no `assets/` directory to unzip (measured
 * 2026-10-24). So the verdict is BOUND TO THE ARTEFACT instead: every build records the APK's
 * sha256, the origin it was planned for and its bundle verdict (`apkbuild.mjs`), and an install
 * without a build requires a record of THAT sha256, for THIS origin, whose bundle passed. Any other
 * APK - built by hand, by CI, by an older rig, for another estate - is refused, naming why.
 *
 * @param {object[]} records the `a1-builds.ndjson` rows
 * @param {string} apkSha256 the sha256 of the file about to be installed
 * @param {string} origin the estate's origin
 * @returns {{ok: true, record: object} | {ok: false, why: string}}
 */
export function installVerdict(records, apkSha256, origin, { acceptDeadLiterals = false } = {}) {
  const same = records.filter((r) => r.apkSha256 === apkSha256);
  if (!same.length) return { ok: false, why: 'no build of this rig recorded this APK (sha256 unknown) - its bundle was never checked' };
  const here = same.filter((r) => r.origin === origin);
  if (!here.length) return { ok: false, why: `this APK was built for ${[...new Set(same.map((r) => r.origin))].join(', ')}, not ${origin}` };
  const last = here[here.length - 1];
  if (last.bundleOk !== true) return { ok: false, why: 'the recorded bundle verdict of this APK did not pass' };
  // AN APK THAT PASSED ONLY BY AN ACCEPTANCE IS INSTALLED ONLY BY THE SAME EXPLICIT GESTURE (review
  // low finding): the acceptance is a decision about an old-client row, and a plain --no-build must
  // not inherit it from a record.
  if (last.acceptedDeadProductionLiteral && !acceptDeadLiterals) {
    return { ok: false, why: `its bundle passed only by accepting ${[].concat(last.acceptedDeadProductionLiteral).join(', ')} (ref ${last.ref}) - pass --accept-dead-production-literal again to install it` };
  }
  return { ok: true, record: last };
}

/** A git ref `--ref` may name: a tag or a branch-like name, never an option or a path. */
export const isBuildableRef = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..');

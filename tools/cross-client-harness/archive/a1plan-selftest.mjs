/**
 * THE A1 APK IS BUILT FOR THE ESTATE `SITE` NAMES, AND NEVER FOR PRODUCTION.
 *
 * `a1plan.mjs` decides, per estate, whether the phone is reverse-forwarded, whether the
 * `local-estate` capability overlay is compiled in, which origins and which identity provider Vite
 * bakes, and whether a packaged bundle may be installed. Until R2 (2026-10-24) the gesture knew the
 * local estate only and REFUSED dev, whose `SITE` has no explicit port. These pin each decision.
 *
 *   bun archive/a1plan-selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINK_MODULE,
  LOCAL_OVERLAY,
  VITE_ORIGIN_KEYS,
  a1BuildPlan,
  buildEnvVerdict,
  bundleTargetVerdict,
  carriesDeadPushFallback,
  installVerdict,
  isBuildableRef,
  linkChunkOf,
  linkModuleOf,
  reversePortFor,
} from '../a1plan.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

const LOCAL = 'http://localhost:8081';
const DEV = 'https://dev.canari-emse.fr';
const IDP = { url: 'https://idp.example.invalid/application/o/x/', clientId: 'dev-client' };

// ── the local estate: unchanged ─────────────────────────────────────────────────────────────────
const local = a1BuildPlan({ site: LOCAL });
ok('local: reverse-forwards the SITE port', local.reversePort === '8081');
ok('local: compiles the local-estate overlay in', local.overlay === LOCAL_OVERLAY && local.args.join(' ') === `android build --debug --config ${LOCAL_OVERLAY}`);
ok('local: every origin is the estate', VITE_ORIGIN_KEYS.every((k) => local.env[k] === LOCAL));
ok('local: the identity provider still comes from frontend/.env', local.authentikFromFrontendEnv && !('VITE_AUTHENTIK_URL' in local.env));
ok('local release: no --debug, overlay kept', a1BuildPlan({ site: LOCAL, release: true }).args.join(' ') === `android build --config ${LOCAL_OVERLAY}`);
ok('a local SITE with NO explicit port is the scheme default, not a refusal', reversePortFor('http://localhost') === '80');

// ── dev: no reverse, no overlay, dev's identity provider, the banner ─────────────────────────────
const dev = a1BuildPlan({ site: `${DEV}/`, devAuthentik: IDP });
ok('dev is planned at all (the old gesture refused a default-port SITE)', dev.estate === 'dev');
ok('dev: no reverse', dev.reversePort === null && reversePortFor(DEV) === null);
ok('dev: no local-estate overlay, a plain debug build', dev.overlay === null && dev.args.join(' ') === 'android build --debug');
ok('dev: every origin is the dev origin, with no trailing slash', VITE_ORIGIN_KEYS.every((k) => dev.env[k] === DEV));
ok("dev: dev's identity provider and client", dev.env.VITE_AUTHENTIK_URL === IDP.url && dev.env.VITE_AUTHENTIK_CLIENT_ID === IDP.clientId && !dev.authentikFromFrontendEnv);
ok('dev: carries the development banner', dev.env.VITE_DEPLOY_ENVIRONMENT === 'development');
ok('dev without DEV_AUTHENTIK is refused, naming it', /DEV_AUTHENTIK/.test(throws(() => a1BuildPlan({ site: DEV }))?.message ?? ''));
ok('dev with a placeholder client is refused', throws(() => a1BuildPlan({ site: DEV, devAuthentik: { url: IDP.url, clientId: '<dev client>' } })) !== null);
ok('dev with a plain-http identity provider is refused', throws(() => a1BuildPlan({ site: DEV, devAuthentik: { url: 'http://idp', clientId: 'x' } })) !== null);

// ── production has no plan ──────────────────────────────────────────────────────────────────────
for (const prod of ['https://canari.emse.fr', 'https://canari-emse.fr']) {
  ok(`${prod}: no build is planned`, throws(() => a1BuildPlan({ site: prod, devAuthentik: IDP }))?.reason === 'production');
  ok(`${prod}: no reverse either`, throws(() => reversePortFor(prod))?.reason === 'production');
}

// ── the packaged bundle names the estate and NOTHING that is production ─────────────────────────
const chunk = (name, text) => ({ name, text });
ok('a bundle naming dev is accepted', bundleTargetVerdict([chunk('a.js', `x="${DEV}"`)], DEV).ok);
ok('a bundle naming nothing is refused', !bundleTargetVerdict([chunk('a.js', 'x=1')], DEV).ok);
const mixed = bundleTargetVerdict([chunk('a.js', `x="${DEV}"`), chunk('b.js', 'y="https://canari.emse.fr"')], DEV);
ok('a bundle naming dev AND production is refused, naming the chunk', !mixed.ok && mixed.production[0].startsWith('b.js: https://canari.emse.fr'));
ok('the legacy production name and its socket are caught too', !bundleTargetVerdict([chunk('a.js', `"${DEV}" "wss://canari-emse.fr/ws"`)], DEV).ok);
ok("dev's own host is not mistaken for the legacy production name", bundleTargetVerdict([chunk('a.js', `"${DEV}" "wss://dev.canari-emse.fr/ws"`)], DEV).ok);
ok('the identity provider is not production\'s application', bundleTargetVerdict([chunk('a.js', `"${DEV}" "https://auth.canari-emse.fr/x"`)], DEV).ok);
ok('a production origin in a LOCAL build is refused as well', !bundleTargetVerdict([chunk('a.js', `"${LOCAL}" "https://canari-emse.fr"`)], LOCAL).ok);

// ── the ONE allowance: publicAppUrl.ts's link constants, as whole literals (2026-10-24, Dypz5d_W.js) ──
const SOURCE = readFileSync(join(REPO, 'frontend', LINK_MODULE), 'utf8');
const MODULE = linkModuleOf(SOURCE);
ok('the link origins are read from the real source: the canonical and the legacy name', MODULE.origins.includes('https://canari.emse.fr') && MODULE.origins.includes('https://canari-emse.fr'));
ok('and its PUBLIC_APP_HOSTS, which is how its chunk is found', MODULE.hosts.join() === 'canari-emse.fr,www.canari-emse.fr,canari.emse.fr');
ok('a source that stops declaring them throws rather than allowing anything (a tag older than the constants too)', throws(() => linkModuleOf('export const X = 1;')) !== null);
// The shape the first dev APK build produced, minified: the hosts array, the constants, and `${DEFAULT}/` as a URL base.
const MEASURED = `ct=[\`canari-emse.fr\`,\`www.canari-emse.fr\`,\`canari.emse.fr\`],ot=\`https://canari.emse.fr\`,st=\`https://canari-emse.fr\`;function ut(){let e=\`${DEV}\`;return e.replace(/\\/$/,\`\`)===\`https://canari-emse.fr\`?ot:e}let e=t??(typeof window<\`u\`?window.location.href:\`https://canari.emse.fr/\`)`;
const OTHER = chunk('other.js', `"${DEV}"`);
const linkChunk = linkChunkOf([chunk('Dypz5d_W.js', MEASURED), OTHER], MODULE.hosts);
ok('the link module chunk is found by its hosts array', linkChunk === 'Dypz5d_W.js');
ok('two or no chunks carrying the array is a throw, not a guess', throws(() => linkChunkOf([OTHER], MODULE.hosts)) !== null && throws(() => linkChunkOf([chunk('a', MEASURED), chunk('b', MEASURED)], MODULE.hosts)) !== null);
const LINK = { origins: MODULE.origins, chunk: linkChunk };
const measured = bundleTargetVerdict([chunk('Dypz5d_W.js', MEASURED), OTHER], DEV, LINK);
ok('the measured link module passes, its four literals listed as tolerated', measured.ok && measured.links.length === 4);
ok('without the allowance the same chunk is refused (the check is not weakened elsewhere)', !bundleTargetVerdict([chunk('Dypz5d_W.js', MEASURED)], DEV).ok);
ok('the SAME whole literal in ANOTHER chunk is refused (R2 review: a layout used it as a request base)', !bundleTargetVerdict([chunk('Dypz5d_W.js', MEASURED), chunk('layout.js', `"${DEV}";f(\`https://canari.emse.fr\`)`)], DEV, LINK).ok);
const refusedIn = (text) => !bundleTargetVerdict([chunk('Dypz5d_W.js', `${MEASURED};${text}`)], DEV, LINK).ok;
ok('a link origin used as a SOCKET is still refused', refusedIn('"wss://canari.emse.fr"'));
ok('a link origin with a PATH is still refused (a request target, not a name)', refusedIn('"https://canari-emse.fr/api/x"'));
ok('a link origin concatenated into a longer literal is still refused', refusedIn('`https://canari.emse.fr${p}`'));
ok('www. is not a link constant and is refused', refusedIn('"https://www.canari-emse.fr"'));
ok('plain http, ws and protocol-relative spellings are refused', refusedIn('"http://canari-emse.fr"') && refusedIn('"ws://canari.emse.fr"') && refusedIn('"//canari-emse.fr"'));
ok('upper case and a trailing dot are refused', refusedIn('"HTTPS://CANARI-EMSE.FR"') && refusedIn('"https://canari.emse.fr."'));
ok("dev's own host and bare hostnames are not production origins", bundleTargetVerdict([chunk('Dypz5d_W.js', MEASURED), chunk('x.js', `"${DEV}" "//dev.canari-emse.fr" "canari-emse.fr"`)], DEV, LINK).ok);

// ── --accept-dead-production-literal: the push fallback of an OLD ref, and nothing else (ADM-5..7) ──
// The shape v1.4.0's layout node compiled to (nodes/0.C1Q5cC68.js, measured 2026-10-24).
const PUSH = 'Dt(Y.historyBaseUrl||`https://canari.emse.fr`,Y.authToken,Y.myDeviceId)';
const ACCEPT = { acceptPushFallback: true };
const LINKD = { ...LINK, defaultOrigin: MODULE.defaultOrigin };
const withPush = [chunk('Dypz5d_W.js', MEASURED), chunk('nodes/0.js', `"${DEV}";${PUSH}`)];
ok('the link module names its DEFAULT origin, which is the only literal the acceptance can match', MODULE.defaultOrigin === 'https://canari.emse.fr');
ok('the push fallback is REFUSED without the flag', !bundleTargetVerdict(withPush, DEV, LINKD).ok);
{
  const v = bundleTargetVerdict(withPush, DEV, LINKD, ACCEPT);
  ok('with the flag the push fallback passes, and is listed as accepted', v.ok && v.accepted.length === 1 && /historyBaseUrl\|\|`https:\/\/canari\.emse\.fr`,/.test(v.accepted[0]));
}
const stillRefused = (text) => !bundleTargetVerdict([...withPush, chunk('x.js', text)], DEV, LINKD, ACCEPT).ok;
ok('with the flag, the legacy-apex comparison v1.4.0 ALSO carries is still refused', stillRefused('return e&&e!==`https://canari-emse.fr`?e:G'));
ok('with the flag, a second push-shaped literal is refused (one acceptance, not a pattern)', stillRefused('Q(Y.historyBaseUrl||`https://canari.emse.fr`,a)'));
ok('with the flag, the canonical origin after another `||` is refused', stillRefused('f(Y.baseUrl||`https://canari.emse.fr`,a)'));
ok('with the flag, the legacy name in the push shape is refused', !bundleTargetVerdict([chunk('Dypz5d_W.js', MEASURED), chunk('n.js', `"${DEV}";Dt(Y.historyBaseUrl||\`https://canari-emse.fr\`,a)`)], DEV, LINKD, ACCEPT).ok);
ok('with the flag, a socket or a path in the push shape is refused', stillRefused('Dt(Y.historyBaseUrl||`wss://canari.emse.fr`,a)') && stillRefused('Dt(Y.historyBaseUrl||`https://canari.emse.fr/api`,a)'));
ok('the flag needs the DEFAULT origin, and says so', throws(() => bundleTargetVerdict(withPush, DEV, LINK, ACCEPT)) !== null);
ok('an OLD layout carries the fallback', carriesDeadPushFallback('startPushService(\n  globalSession.historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN,'));
ok("this tree's layout does not (#2385), so the flag has nothing to accept here", !carriesDeadPushFallback('startPushService(globalSession.historyBaseUrl, x)'));

// ── an APK installed without a build carries a recorded verdict: same sha256, same origin, passed ──
const REC = [{ apkSha256: 'aa', origin: DEV, bundleOk: true, recordedAt: 't1' }, { apkSha256: 'bb', origin: LOCAL, bundleOk: true, recordedAt: 't2' }];
ok('--no-build: an APK whose build recorded a passing verdict for this origin may be installed', installVerdict(REC, 'aa', DEV).ok);
ok('--no-build: an unknown APK (CI, by hand, an older rig) is refused', /never checked/.test(installVerdict(REC, 'cc', DEV).why ?? ''));
ok('--no-build: an APK built for ANOTHER estate is refused', /built for http:\/\/localhost:8081/.test(installVerdict(REC, 'bb', DEV).why ?? ''));
ok('--no-build: a failed or absent verdict is refused', !installVerdict([{ apkSha256: 'dd', origin: DEV }], 'dd', DEV).ok);

// ── the build ENVIRONMENT names no production origin, from the process or a .env file ──────────────
const planned = { ...dev.env };
ok('the dev plan itself is clean', buildEnvVerdict(planned).ok);
ok('a production VITE_ value in the process environment is refused', !buildEnvVerdict({ ...planned, VITE_AUTHENTIK_REDIRECT_URI: 'https://canari.emse.fr/auth' }).ok);
const stale = [{ name: '.env', text: 'VITE_AUTHENTIK_REDIRECT_URI=https://canari-emse.fr/auth\nVITE_GATEWAY_URL=https://canari-emse.fr' }];
const staleVerdict = buildEnvVerdict(planned, stale);
ok('a stale .env key the plan does not override is refused, named', !staleVerdict.ok && staleVerdict.offenders.join() === '.env VITE_AUTHENTIK_REDIRECT_URI');
ok('a stale .env origin the plan DOES override is not (the environment wins in Vite)', buildEnvVerdict(planned, [{ name: '.env', text: 'VITE_GATEWAY_URL=https://canari-emse.fr' }]).ok);
ok("a non-VITE key is not Vite's business", buildEnvVerdict({ ...planned, HOMEPAGE: 'https://canari.emse.fr' }).ok);
ok('an `export VITE_X=` line is read as Vite reads it, and refused', !buildEnvVerdict(planned, [{ name: '.env', text: 'export VITE_AUTHENTIK_REDIRECT_URI="https://canari.emse.fr/auth"' }]).ok);
ok('an upper-case or http production value in the environment is refused', !buildEnvVerdict({ ...planned, VITE_X: 'HTTP://CANARI-EMSE.FR' }).ok);

// ── --ref names a tag, never an option or a path ────────────────────────────────────────────────
ok('v1.4.0 is a buildable ref', isBuildableRef('v1.4.0'));
ok('an option is not', !isBuildableRef('--upload-pack=x'));
ok('a parent path is not', !isBuildableRef('../x'));

console.log(failures ? `[a1plan] ${failures} FAILURE(S)` : '[a1plan] clean - local unchanged, dev built without reverse or overlay, production never planned');
process.exit(failures ? 1 : 0);

/**
 * BUILD THE A1 APK AGAINST THE ESTATE `SITE` NAMES (LOCAL OR DEV), INSTALL IT, AND PROVE THE PHONE IS RUNNING IT.
 *
 *   bun a1apk.mjs               # reverse (local only) + build + install + prove
 *   bun a1apk.mjs --no-build    # reverse (local only) + install the APK already on disk + prove
 *   bun a1apk.mjs --reverse     # only the reverse, which is what a replug costs (local only)
 *   bun a1apk.mjs --release     # the MINIFIED, resource-shrunk build for check R - COSTS THE DEVICE
 *   bun a1apk.mjs --build-only  # build and assert the artifact; touch no phone, not even adb
 *   bun a1apk.mjs --build-only --ref v1.4.0   # an OLD client, built from that tag in its own worktree
 *   bun a1apk.mjs --build-only --ref v1.4.0 --accept-dead-production-literal   # ADM-5..7 only, see the README
 *
 * **THE ESTATE DECIDES THE BUILD (R2, 2026-10-24)**, through `a1plan.mjs`: the local estate gets the
 * `adb reverse` and the `local-estate` overlay described below; DEV (`https://dev.canari-emse.fr`)
 * gets neither - the phone reaches it over its radios, inside the default `https://**` scope - and
 * takes dev's identity-provider values from `names.mjs` `DEV_AUTHENTIK`, as the pre-release pipeline
 * takes them from its `DEV_` secrets. Production has no build here: `site.mjs` refused it first.
 *
 * **`--ref <tag>` builds an OLD client** for the mixed-version rows: a detached worktree of that tag
 * under the system temp dir (`a1-ref-<tag>`), its own `bun install` and `bun run generate`, the same
 * plan and the same bundle assertions. The working tree is never checked out over. The APK is copied
 * to `STATE_DIR/apks/` under the ref's name so a later build cannot overwrite it.
 *
 * The four facts below are the LOCAL estate's; on dev, (1) does not apply and (2)'s overlay is absent.
 *
 * WHY THIS IS AN ATOM AND NOT A PARAGRAPH IN THE README. The invocation was documented and nothing
 * executed it, so every session retyped it - and the copy went stale in the one place a copy always
 * does: the README names NDK `26.1.10909125`, and this workstation has `29.0.13846066` and nothing
 * else. A path spelt in prose is a path nobody re-measures. Everything below is DISCOVERED and then
 * ASSERTED, which is the rule the rest of this rig already follows.
 *
 * ## The four facts this gesture rests on, each verified here rather than assumed
 *
 * 1. **The phone reaches the estate over `adb reverse`, per device, and it does not survive a
 *    replug.** `SITE` is `http://localhost:<port>` for the workstation; `adb reverse tcp:<port>
 *    tcp:<port>` makes the SAME string true on the phone, which is why nothing here rewrites a URL.
 * 2. **Cleartext to `localhost` is NOT a debug-only privilege, and the sentence here said it was.**
 *    `build.gradle.kts` does set `usesCleartextTraffic=true` for the debug type alone - but that
 *    attribute is only the BASE config, and `network_security_config.xml` lives in `src/main/res`,
 *    applies to every build type, and names `tauri.localhost` and `localhost` in a `domain-config`
 *    that overrides the base for exactly those two. Measured on the release ARTIFACT rather than
 *    argued: `aapt2 dump xmltree` on `app-universal-release.apk` reads
 *    `cleartextTrafficPermitted=true` over both domains, in a resource the shrinker renamed to
 *    `res/8G.xml` and kept. What a `--debug` build really buys is `run-as`, the native half of a
 *    footprint row - and what a release build lacks for the local estate is the Tauri CAPABILITY
 *    scope, which `--config src-tauri/tauri.local.conf.json` supplies to either build type. This
 *    says what the APK PERMITS; only a run says what it reaches.
 * 3. **`BUILD_WEB` must be UNSET.** The APK embeds its frontend (`frontendDist: "../build"`) and
 *    Tauri needs the adapter-STATIC shape. Inheriting `BUILD_WEB=1` from a shell that had just
 *    deployed the local estate would package an adapter-node build - a `build/` with no
 *    `index.html` at its root - so it is deleted from the child environment explicitly.
 * 4. **The seven origins travel as environment variables, not as an edit to `frontend/.env`.** That
 *    file is generated and shared with `bun run dev`, which must stay same-origin; writing the
 *    absolute URLs into it would break the dev server for the rest of the session. Vite reads
 *    `VITE_*` from the process environment, and this asserts that it did by grepping the artefact.
 *
 * ## What it refuses to do
 *
 * **It never uninstalls.** `adb install -r` keeps the app data, which is the enrolment and the MLS
 * store; an uninstall costs a new DEVICE with no history, and a HEAL row reasons about exactly that
 * history. If the signature ever mismatches, the fix is to build debug - not to uninstall.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  LAYOUT_MODULE,
  LINK_MODULE,
  a1BuildPlan,
  buildEnvVerdict,
  bundleTargetVerdict,
  carriesDeadPushFallback,
  installVerdict,
  isBuildableRef,
  linkChunkOf,
  linkModuleOf,
  reversePortFor,
} from './a1plan.mjs';
import { apkBuilds, recordApkBuild } from './apkbuild.mjs';
import * as NAMES from './names.mjs';
import { STATE_DIR } from './names.mjs';
import { SITE } from './site.mjs';
import { PKG, adb, serial, useDevice } from './phone.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const FRONTEND = join(REPO, 'frontend');

/**
 * The build this estate needs (`a1plan.mjs`). `DEV_AUTHENTIK` is machine-local and read through the
 * namespace, so a `names.mjs` that predates it still imports for a local build.
 */
const planFor = (release = false) => a1BuildPlan({ site: SITE, release, devAuthentik: NAMES.DEV_AUTHENTIK });

/**
 * `http://localhost:8081` -> `8081`; `http://localhost` -> `80` (the old refusal read the scheme's
 * default port as "no port"). The port is what `adb reverse` maps; the URL is unchanged. NULL ON
 * DEV, which the phone reaches over its radios and which maps nothing.
 */
/** The sha256 of a file, hex - what binds an APK to the bundle verdict its build recorded. */
const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function sitePort() {
  return reversePortFor(SITE);
}

/**
 * A detached worktree of `ref`, ready to build: `bun install` and the generated WASM and protobuf
 * (`frontend/src/lib/wasm/` and `canari.{js,d.ts}` are not in git). Reused when it already sits on
 * that commit, so a second `--ref` build is a build and not a forty-minute setup.
 *
 * @returns {{frontend: string, repo: string}}
 */
function refTree(ref, tag) {
  if (!isBuildableRef(ref)) throw new Error(`--ref '${ref}' is not a tag or branch name`);
  const commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const dir = join(tmpdir(), `a1-ref-${ref.replace(/[^A-Za-z0-9.-]/g, '_')}`);
  if (existsSync(dir)) {
    const at = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (at !== commit) {
      throw new Error(`${dir} exists at ${at.slice(0, 9)}, not ${ref} (${commit.slice(0, 9)}) - remove it with git worktree remove`);
    }
  } else {
    console.log(`[${tag}] worktree of ${ref} (${commit.slice(0, 9)}) at ${dir}`);
    execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, commit], { stdio: 'inherit' });
  }
  const frontend = join(dir, 'frontend');
  // THE ONE BUILD INPUT GIT DOES NOT CARRY: the Firebase config the `google-services` gradle plugin
  // refuses to build without (gitignored; a build credential). It is the same file the checkout
  // running this rig builds with, so it is copied from there - and its absence there is a refusal.
  const GOOGLE_SERVICES = 'src-tauri/gen/android/app/google-services.json';
  if (!existsSync(join(frontend, GOOGLE_SERVICES))) {
    if (!existsSync(join(FRONTEND, GOOGLE_SERVICES))) {
      throw new Error(`${GOOGLE_SERVICES} is absent from ${FRONTEND} too - the Android build cannot run without it`);
    }
    copyFileSync(join(FRONTEND, GOOGLE_SERVICES), join(frontend, GOOGLE_SERVICES));
  }
  for (const args of [
    ['install', '--frozen-lockfile'],
    ['run', 'generate'],
  ]) {
    console.log(`[${tag}] ${ref}: bun ${args.join(' ')}`);
    const r = spawnSync(process.execPath, args, { cwd: frontend, stdio: 'inherit', timeout: 30 * 60_000 });
    if (r.status !== 0) throw new Error(`${ref}: bun ${args.join(' ')} exited ${r.status} - this ref does not build with today's toolchain`);
  }
  return { frontend, repo: dir };
}

/**
 * The Android SDK, and the NDK inside it, DISCOVERED.
 *
 * The NDK is picked as the highest version present rather than named: a hardcoded version is the
 * thing that rotted in the README, and there is nothing about this build that wants an older one.
 * Both are asserted, because `tauri android build` fails deep inside gradle with an error that does
 * not say "no NDK" when they are missing.
 */
function toolchain() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    process.env.HOME ? join(process.env.HOME, 'Android', 'Sdk') : null,
  ].filter(Boolean);
  const sdk = candidates.find((p) => existsSync(join(p, 'platform-tools')));
  if (!sdk) {
    throw new Error(
      `no Android SDK found - looked for platform-tools under:\n  ${candidates.join('\n  ')}`
    );
  }
  const ndkRoot = join(sdk, 'ndk');
  if (!existsSync(ndkRoot)) throw new Error(`SDK at ${sdk} has no ndk/ directory`);
  const versions = readdirSync(ndkRoot)
    .filter((d) => statSync(join(ndkRoot, d)).isDirectory())
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) < 0 ? 1 : -1
    );
  if (!versions.length) throw new Error(`no NDK installed under ${ndkRoot}`);
  return { sdk, ndk: join(ndkRoot, versions[0]), ndkVersion: versions[0] };
}

/** The two Authentik values, read from the generated `frontend/.env` - local authenticates against
 *  the PRODUCTION identity provider (workflow-migration decision 8), so they are not derived. */
function authentikEnv(frontend = FRONTEND) {
  const file = join(frontend, '.env');
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(VITE_AUTHENTIK_URL|VITE_AUTHENTIK_CLIENT_ID)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * THE PHONE'S ONLY ROUTE TO THE ESTATE, RAISED OR CUT - and asserted in BOTH directions.
 *
 * On this bench the phone does not reach the estate over its radios at all: `SITE` is
 * `http://localhost:<port>` on the workstation, and `adb reverse` makes that same string true on
 * the device, over the USB cable. Two consequences, and the second is why this is exported.
 *
 * 1. **`adb reverse` answers 0 for a forward that is not there** once the device has gone between
 *    the two calls, so the LIST is read back rather than the exit code believed - a check that
 *    believes it measures a phone talking to nothing, which reads exactly like a server fault.
 * 2. **`svc wifi disable` DOES NOT TAKE THIS PHONE OFFLINE.** LIFE-6 is "offline (radios off)" and
 *    its premise - "nothing can arrive while the radios are down" - stopped being true the day the
 *    rig moved to the LOCAL estate (2026-09-03): on its first execution the message crossed the
 *    cable, the app raised a notification 2.2s later, and the row reported FAIL about a phone that
 *    had never been offline. Cutting the radios is HALF of that state; cutting this is the other.
 *
 * 3. **`--remove` DOES NOT CUT A SOCKET THAT IS ALREADY OPEN.** It closes the LISTENER; the
 *    connection the app holds keeps carrying data. So it cannot simulate a stream gap - the Mi 9T
 *    pass's D5 (2026-10-06) saw none, as LIFE-6 had on 2026-09-07. It stops NEW connections only.
 *    A gap is made by `restartGateway()` in `estate.mjs` (`docker restart` of the chat gateway),
 *    which is what worked for D1.
 *
 * `--remove` on a forward that is already gone exits non-zero, so it is tolerated and the list is
 * what decides - the same rule as the raise, in the same place.
 */
export function estateReverse(up, tag = 'A1', port = sitePort()) {
  // DEV HAS NO REVERSE: the phone reaches it over its own radios, so there is nothing to raise and
  // nothing to cut - a row that needs the phone offline cuts the radios, and on dev that is ENOUGH.
  if (port === null) {
    console.log(`[${tag}] no reverse on this estate (${SITE}) - the phone reaches it over its radios`);
    return { dev: null, up: null, port: null };
  }
  const dev = serial();
  try {
    adb(up ? ['reverse', `tcp:${port}`, `tcp:${port}`] : ['reverse', '--remove', `tcp:${port}`]);
  } catch (e) {
    if (up) throw e; // a raise that failed is fatal; a remove of nothing is already the state asked for
  }
  const listed = adb(['reverse', '--list']);
  const isUp = listed.includes(`tcp:${port}`);
  console.log(`[${tag}] reverse tcp:${port} on ${dev}: ${isUp ? 'up' : 'down'}`);
  if (isUp !== up) {
    throw new Error(
      `adb reverse tcp:${port} should be ${up ? 'up' : 'down'} and the list says otherwise:
${listed}`
    );
  }
  return { dev, up: isUp, port };
}

/**
 * The gesture, as a function, so importing this file does NOT build an APK.
 *
 * IT DID, and that is why the guard is here: the first `await import('./a1apk.mjs')` written to
 * check that the file parses started a forty-minute Android build. An atom other checks are meant
 * to reuse cannot have its work at module scope - the rule the four other dual-purpose files in
 * this directory already follow with the same `pathToFileURL` guard.
 */
export async function armA1({
  build = true,
  reverseOnly = false,
  device = 'A1',
  release = false,
  buildOnly = false,
  ref = null,
  acceptDeadProductionLiteral = false,
} = {}) {
  const plan = planFor(release);
  if (ref && !buildOnly) {
    throw new Error(
      '--ref builds an OLD client for a mixed-version row and installs nothing - pass --build-only, ' +
        'then install that APK when the row says so'
    );
  }
  // FOR OLD REFS ONLY, AND NEVER IMPLIED (decided 2026-10-24 for ADM-5..7): see the README.
  if (acceptDeadProductionLiteral && !((buildOnly && ref) || (!build && !buildOnly))) {
    throw new Error(
      '--accept-dead-production-literal is for an OLD client only: pass it with --build-only --ref <tag> to build one, ' +
        'or with --no-build to install the APK such a build recorded'
    );
  }
  // BINDS THE NAMED PHONE ITSELF, defaulting to the one this atom is named for.
  //
  // With two phones attached, `serial()` refuses rather than choosing - correctly, and it says so:
  // "pass --device to an atom so it can call useDevice()". This file was that atom and did not,
  // so `bun a1apk.mjs` on a two-phone bench aborted before the reverse, on an ambiguity the file
  // itself could resolve. Making the CALLER export ANDROID_SERIAL is how the wrong phone gets an
  // A1 build: the shell is where the two names are easiest to confuse.
  //
  // `useDevice` sets `ANDROID_SERIAL` in this process, so it also reaches the `adb` and `tauri`
  // children spawned below - the binding is the whole subtree's, not this module's.
  //
  // `--device` exists because the APK is not A1's: it is the LOCAL-ESTATE build, and any phone on
  // the bench may need it. The file keeps its name because eight places reference it and a rename
  // buys nothing; `[A1]` in the log below is the DEVICE, so a line always says which phone it is
  // about. Arming a second phone is `bun a1apk.mjs --no-build --device A2` - the build is shared,
  // and rebuilding it per phone would only risk two of them differing.
  // A BUILD-ONLY RUN TOUCHES NO PHONE, NOT EVEN TO BIND ONE: `useDevice` asks adb, and the reverse
  // writes to the device. Before R2 both ran ahead of the build whatever the flag said.
  if (!buildOnly) useDevice(device);
  const TAG = device;

  // ── the reverse, which is the whole of what a replug costs ────────────────────────────────
  // ONE IMPLEMENTATION, at module level above, because LIFE-6 needs the other direction too.
  const reverse = (port) => estateReverse(true, TAG, port).dev ?? serial();

  const PORT = plan.reversePort;

  // A RETURN, NOT AN EXIT. `process.exit` in a library kills the caller's run too, and this atom
  // exists to be called by the phases that arm the phone.
  if (reverseOnly) return { reversed: PORT !== null, dev: reverse(PORT) };

  const dev = buildOnly ? null : reverse(PORT);
  const { sdk, ndk, ndkVersion } = toolchain();
  console.log(`[${TAG}] SDK ${sdk}`);
  console.log(`[${TAG}] NDK ${ndkVersion} (discovered, not named)`);
  console.log(
    `[${TAG}] estate ${plan.estate}, origin ${plan.origin}` +
      (PORT ? ' - the same string on both sides of the reverse' : " - reached over the phone's radios, no reverse")
  );
  const tree = ref ? refTree(ref, TAG) : { frontend: FRONTEND, repo: REPO };
  // A REF THAT NO LONGER CARRIES THE FALLBACK (#2385 and later) HAS NOTHING TO ACCEPT, so the flag
  // is refused there rather than left to widen a check it cannot narrow to anything.
  if (acceptDeadProductionLiteral && ref && !carriesDeadPushFallback(readFileSync(join(tree.frontend, LAYOUT_MODULE), 'utf8'))) {
    throw new Error(`--accept-dead-production-literal refused: ${ref}'s ${LAYOUT_MODULE} carries no push-service production fallback to accept`);
  }

  // THE RELEASE VARIANT IS FOR CHECK R AND COSTS THE DEVICE, which is why it is a flag and not a
  // default. `isMinifyEnabled` and `isShrinkResources` are on for this build type ALONE, so it is
  // the only artifact in which a stripped class or resource can surface - and it is signed with the
  // release keystore, so it cannot be installed over the debug build without an uninstall that
  // destroys the enrolment and the MLS store. Everything else is identical, the local-estate
  // overlay included: `network_security_config.xml` lives in `src/main/res`, applies to every build
  // type, and names `localhost`, so cleartext to the estate is NOT a debug-only privilege.
  const APK = join(
    tree.frontend,
    release
      ? 'src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk'
      : 'src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'
  );

  if (build) {
    // Relative to the frontend, which is this build's cwd - `--config` resolves against the cwd.
    if (plan.overlay && !existsSync(join(tree.frontend, plan.overlay))) {
      throw new Error(
        `${plan.overlay} is absent - without it the APK compiles capability \`default\` alone and every ` +
          `call to the local estate is refused by scope. It is not optional.`
      );
    }

    const tauri = join(tree.frontend, 'node_modules/.bin/tauri.exe');
    if (!existsSync(tauri)) {
      throw new Error(
        `${tauri} is missing - and \`npx tauri\` / \`bun tauri\` do not resolve on this box, so the ` +
          `binary is the only way in. Run \`bun install\` in frontend/.`
      );
    }

    const env = { ...process.env };
    // (3) above: the APK wants adapter-static, and this shell may have just built the web shape.
    delete env.BUILD_WEB;
    env.ANDROID_HOME = sdk;
    env.ANDROID_SDK_ROOT = sdk;
    env.NDK_HOME = ndk;
    // The origins (and on dev the identity provider and the banner) come from the plan; the local
    // estate keeps reading its Authentik pair from the generated `frontend/.env`.
    Object.assign(env, plan.env);
    // FROM THIS CHECKOUT'S `frontend/.env`, the machine's configuration, even for a `--ref` build:
    // a ref worktree is a fresh checkout and has no `.env` of its own (R2 review).
    if (plan.authentikFromFrontendEnv) Object.assign(env, authentikEnv(FRONTEND));

    // NO PRODUCTION ORIGIN MAY REACH VITE, checked at the source before a minute is spent building:
    // the bundle cannot tell a baked request target from a link constant, the environment can.
    const envFiles = readdirSync(tree.frontend)
      .filter((f) => /^\.env(\..+)?$/.test(f) && !f.endsWith('.example'))
      .map((name) => ({ name, text: readFileSync(join(tree.frontend, name), 'utf8') }));
    const envVerdict = buildEnvVerdict(env, envFiles);
    if (!envVerdict.ok) {
      throw new Error(`a VITE_* value this build would bake names a PRODUCTION origin: ${envVerdict.offenders.join(', ')}`);
    }

    const logDir = join(STATE_DIR, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `a1apk-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    console.log(`[${TAG}] building (${release ? 'RELEASE - minified and resource-shrunk' : 'debug'}) - output to ${logFile}`);
    console.log(`[${TAG}]   NOT piped: this build buffers until exit, so a pipe loses all progress.`);

    // `stdio: inherit` for the same reason the README gives: piping it hides every line until the
    // process ends, and a stalled build then looks identical to a slow one.
    // (5) THE LOCAL ESTATE IS OPT-IN, AND THIS FLAG IS THE ONLY THING THAT OPTS IN.
    // `tauri.conf.json` names capability `default` alone, whose fetch scope is `https://**` - so a
    // build without this overlay produces an APK that REFUSES the estate it was pointed at, with the
    // product's own red "url not allowed on the configured scope". The overlay adds `local-estate`,
    // and nothing else does, which is what keeps a release build from ever compiling it.
    // On dev the plan carries no `--config`: the default capability already covers `https://**`.
    const args = plan.args;
    const built = spawnSync(tauri, args, {
      cwd: tree.frontend,
      env,
      stdio: 'inherit',
      timeout: 45 * 60_000,
    });
    if (built.status !== 0) {
      throw new Error(`tauri android build ${args.join(' ')} exited ${built.status}`);
    }

    if (!existsSync(APK)) {
      throw new Error(
        `build reported success but ${APK} is absent - note it is universal/, never arm64/, which is stale`
      );
    }

    // (4) above, MEASURED: did Vite actually take the origins from the environment? The packaged
    // bundle is the only place that can answer, and an APK pointing at production would otherwise be
    // found by a row that fails for a reason nobody can see.
    // AND NOTHING ELSE THAT IS PRODUCTION (R2): a bundle naming the estate can still carry a
    // production origin beside it, taken from a stale `frontend/.env`, and an APK calling both is an
    // APK on production.
    // EVERY packaged script, not the chunks alone: `nodes/` and `entry/` are code too (R2 review).
    const immutable = join(tree.frontend, 'build/_app/immutable');
    const texts = existsSync(immutable)
      ? readdirSync(immutable, { recursive: true })
          .map(String)
          .filter((f) => f.endsWith('.js'))
          .map((name) => ({ name: name.split(sep).join('/'), text: readFileSync(join(immutable, name), 'utf8') }))
      : [];
    const linkModule = linkModuleOf(readFileSync(join(tree.frontend, LINK_MODULE), 'utf8'));
    const link = { origins: linkModule.origins, chunk: linkChunkOf(texts, linkModule.hosts), defaultOrigin: linkModule.defaultOrigin, legacyOrigin: linkModule.legacyOrigin };
    const verdict = bundleTargetVerdict(texts, plan.origin, link, { acceptDeadLiterals: acceptDeadProductionLiteral });
    console.log(
      `[${TAG}] ${plan.origin} appears in ${verdict.hits.length} packaged chunk(s), a production origin in ` +
        `${verdict.production.length}; ${verdict.links.length} production LINK constant(s) of ${LINK_MODULE} tolerated`
    );
    for (const a of verdict.accepted) {
      console.log(`[${TAG}] ACCEPTED by --accept-dead-production-literal (old ref ${ref}): ${a}`);
    }
    if (!verdict.hits.length) {
      throw new Error(
        `the built bundle does not mention ${plan.origin} - Vite did not take the VITE_*_URL from the ` +
          `environment, so this APK would talk to whatever frontend/.env says`
      );
    }
    if (verdict.production.length) {
      throw new Error(`the built bundle names a PRODUCTION origin beside ${plan.origin}: ${verdict.production.join(' | ')}`);
    }

    // WHETHER THIS APK IS ANY COMMIT AT ALL, written down while the answer is still knowable.
    //
    // A verdict's `a1Build` is the HEAD the bundle names, exact only for a clean
    // tree. This gesture builds from the WORKING tree, which is the point of it and the normal shape of a session: write a
    // fix, build, measure, commit. On 2026-09-08 that put NOTIF-16's PASS against `1fd7cecd7`, the
    // commit BEFORE the fix that makes it pass. Recorded rather than refused: a gate against a
    // dirty build would make the fix-and-measure loop impossible. See `apkbuild.mjs`.
    // AND WHICH ARTEFACT, FOR WHICH ESTATE, PASSED: an install without a build (`--no-build`) is
    // allowed only for an APK whose sha256 is recorded here for this origin (`installVerdict`).
    // AN ACCEPTANCE IS PART OF THE VERDICT, so it is written beside it: a reader of this record must
    // see that the bundle passed only because a dead production literal was accepted, and where.
    const acceptance = verdict.accepted.length ? { acceptedDeadProductionLiteral: verdict.accepted.map((a) => a.split(" ")[0]), accepted: verdict.accepted } : {};
    const provenance = recordApkBuild(tree.repo, { apkSha256: sha256Of(APK), origin: plan.origin, estate: plan.estate, ref, bundleOk: true, ...acceptance });
    console.log(
      `[${TAG}] built from ${provenance.head}` +
        (provenance.dirty
          ? ` plus UNCOMMITTED changes (diff ${provenance.diffSha}) - a verdict on this APK is NOT a verdict on that commit`
          : ' with a clean tree - the commit describes this APK exactly')
    );
  }

  // AN ARTIFACT CAN BE ASKED QUESTIONS WITHOUT A PHONE, and the answers that matter most are of
  // that kind: what a shipped library COMPILES was settled by counting a string in it against a
  // control, and a runtime probe on a development ROM could not corroborate either half. So the
  // build and its assertions stand alone, and installing is a separate decision - which the release
  // variant makes irreversible.
  if (buildOnly) {
    // A REF BUILD IS KEPT UNDER ITS NAME: the next build in that worktree would overwrite the path.
    if (ref) {
      const kept = join(STATE_DIR, 'apks', `canari-${ref.replace(/[^A-Za-z0-9.-]/g, '_')}-${plan.estate}-${release ? 'release' : 'debug'}.apk`);
      mkdirSync(join(STATE_DIR, 'apks'), { recursive: true });
      copyFileSync(APK, kept);
      console.log(`[${TAG}] --build-only --ref ${ref}: kept at ${kept}; no phone was touched`);
      return { apk: kept, installed: false, dev };
    }
    console.log(`[${TAG}] --build-only: the APK is at ${APK} and no phone was touched`);
    return { apk: APK, installed: false, dev };
  }

  // ── install, and NEVER uninstall ────────────────────────────────────────────────────────────────
  // AN APK THIS RUN DID NOT BUILD IS INSTALLED ONLY IF ITS BUNDLE VERDICT IS ON RECORD (R2 review):
  // the bundle cannot be re-read from the APK (Tauri embeds it compressed in the native library),
  // so the verdict a build recorded is bound to the file's sha256 and to the estate it was for.
  if (!build) {
    const sha = sha256Of(APK);
    const v = installVerdict(apkBuilds(), sha, plan.origin, { acceptDeadLiterals: acceptDeadProductionLiteral });
    if (!v.ok) throw new Error(`--no-build refuses ${APK} (sha256 ${sha.slice(0, 12)}): ${v.why}. Build it with bun a1apk.mjs.`);
    console.log(`[${TAG}] --no-build: this APK's bundle passed for ${plan.origin} when it was built (${v.record.recordedAt})`);
    if (v.record.acceptedDeadProductionLiteral) {
      console.log(`[${TAG}] --no-build: it passed WITH an accepted dead production literal (${v.record.acceptedDeadProductionLiteral}, ref ${v.record.ref}) - an old-client row only`);
    }
  }
  console.log(`[${TAG}] installing ${APK}`);
  const before = adb(['shell', 'dumpsys', 'package', PKG]);
  const verOf = (dump) => /versionName=(\S+)/.exec(dump)?.[1] ?? '(none)';
  const codeOf = (dump) => /versionCode=(\d+)/.exec(dump)?.[1] ?? '(none)';
  console.log(`[${TAG}] installed before: ${verOf(before)} (code ${codeOf(before)})`);

  // A DELIBERATE UNINSTALL, AND ONLY IN THE ONE DIRECTION THAT CANNOT AVOID IT. The release APK is
  // signed with another key, so `install -r` over the debug build is refused - and the refusal is
  // correct, which is why it is not simply caught below. What makes this legitimate is that the
  // caller asked for the release variant, which is a decision about the DEVICE and not about the
  // install step: check R exists to measure the shrunk artifact and there is no shrunk artifact
  // signed with the debug key. Everything it costs is named here rather than discovered afterwards.
  if (release && before.length > 0 && /DEBUGGABLE/.test(before)) {
    console.log(
      `[${TAG}] UNINSTALLING the debug build first - the release APK is signed with another key and ` +
        `cannot replace it. THIS DESTROYS the enrolment, the MLS store and every runtime grant: the ` +
        `phone comes back as a NEW device that has to log in, set a PIN, re-join every conversation ` +
        `and be re-granted POST_NOTIFICATIONS.`
    );
    const removed = spawnSync('adb', ['-s', dev, 'uninstall', PKG], { encoding: 'utf8' });
    const saidRemoved = `${removed.stdout ?? ''}${removed.stderr ?? ''}`.trim();
    if (removed.status !== 0 || !/Success/i.test(saidRemoved)) {
      throw new Error(`uninstall before the release install failed: ${saidRemoved || '(no output)'}`);
    }
    console.log(`[${TAG}] uninstalled - the device that was on this phone no longer exists`);
  }

  const install = spawnSync('adb', ['-s', dev, 'install', '-r', APK], {
    encoding: 'utf8',
    timeout: 10 * 60_000,
  });
  const said = `${install.stdout ?? ''}${install.stderr ?? ''}`.trim();
  console.log(`[${TAG}] ${said.split('\n').slice(-3).join(' | ')}`);
  if (install.status !== 0 || /Failure|INSTALL_FAILED/i.test(said)) {
    // WHICH SIDE IS THE RELEASE BUILD, NAMED FROM THE DUMP RATHER THAN ASSUMED. This threw
    // "the APK is a RELEASE build" for both directions until 2026-09-24, and sent a session
    // looking for a debug APK it was already holding: the mismatch was the other way round -
    // the PHONE carried a release build, left there by a devtools verification. The dump
    // already answers it. `DEBUGGABLE` is in pkgFlags for a debug build and absent for a
    // release one, and a release build cannot have been installed OVER the debug one, so its
    // presence proves an uninstall already happened and the enrolment is already gone -
    // `firstInstallTime` says when. That is the one case where uninstalling costs nothing.
    const phoneIsRelease = before.length > 0 && !/DEBUGGABLE/.test(before);
    const installedAt = /firstInstallTime=(\S+ \S+)/.exec(before)?.[1] ?? 'an unrecorded time';
    throw new Error(
      phoneIsRelease
        ? `install -r failed: the PHONE carries a RELEASE build (${verOf(before)}, installed ` +
          `${installedAt}) and this APK is the debug one. A release build cannot be installed over ` +
          `a debug build, so the uninstall that put it there ALREADY destroyed the enrolment and ` +
          `the MLS store - re-check that with firstInstallTime, and if it holds, uninstalling now ` +
          `costs nothing that is not already lost.`
        : `install -r failed: the APK is a RELEASE build. Build debug rather than uninstalling - ` +
          `an uninstall destroys the enrolment and the MLS store this device is for.`
    );
  }

  const after = adb(['shell', 'dumpsys', 'package', PKG]);
  console.log(`[${TAG}] installed after : ${verOf(after)} (code ${codeOf(after)})`);

  // A FRESH INSTALL IS A NEW DEVICE, AND NOTHING DOWNSTREAM SAYS SO. `install -r` keeps
  // `firstInstallTime`; only a package that was uninstalled first gets a new one, so the two
  // clocks being equal IS the proof that the enrolment, the MLS store and every runtime grant
  // are gone. Two things then mislead the next run: the app looks installed and at the right
  // version, and `POST_NOTIFICATIONS` is back to DENIED - which the rig treats as ambient
  // (`archive/life.mjs` revokes it and grants it back), so a push row would fail for a reason
  // nothing names. This says both out loud rather than granting anything back: a grant here
  // would hide the loss, and the enrolment cannot be restored by one.
  const firstInstall = /firstInstallTime=(\S+ \S+)/.exec(after)?.[1] ?? null;
  const lastUpdate = /lastUpdateTime=(\S+ \S+)/.exec(after)?.[1] ?? null;
  if (firstInstall && firstInstall === lastUpdate) {
    const notifs = /android[.]permission[.]POST_NOTIFICATIONS: granted=(\w+)/.exec(after)?.[1];
    console.log(
      `[${TAG}] THIS IS A NEW DEVICE: firstInstallTime == lastUpdateTime (${firstInstall}), so the ` +
        `package was uninstalled before this install and took the enrolment and the MLS store with ` +
        `it. POST_NOTIFICATIONS granted=${notifs ?? '(unknown)'} - a push row needs it granted, and ` +
        `every conversation this device held has to be re-joined.`
    );
  }

  // The reverse survives an install but not a replug, so it is re-asserted here rather than assumed:
  // this is the last moment at which a caller can be told the phone cannot reach the estate.
  reverse(PORT);
  console.log(`[${TAG}] done - the app still has to be launched and unlocked (pin.mjs --device ${TAG})`);
  if (build) {
    // THE ESTATE'S SOURCE ARTEFACT IS NOW THE WRONG SHAPE, and nothing downstream would say so.
    // `beforeBuildCommand` is `bun run build`, which writes the SAME `frontend/build` the local
    // estate is packaged from - so a `docker compose up --build frontend-ssr` after this ships a
    // container that dies on `Cannot find module '/app/index.js'`. The README already forbids two
    // builds racing over that directory; this is the other half, which is that the loser is left
    // behind on disk looking perfectly fine.
    console.log(
      `[${TAG}] NOTE: frontend/build now holds the TAURI (adapter-static) shape. Run \`make ` +
        `local-frontend\` before rebuilding the estate's frontend images.`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--device');
  const device = at >= 0 ? argv[at + 1] : 'A1';
  if (at >= 0 && !device) throw new Error('--device needs a name, as names.mjs spells it (A1, A2)');
  const atRef = argv.indexOf('--ref');
  const ref = atRef >= 0 ? argv[atRef + 1] : null;
  if (atRef >= 0 && !ref) throw new Error('--ref needs a tag, e.g. v1.4.0');
  armA1({
    ref,
    build: !argv.includes('--no-build'),
    reverseOnly: argv.includes('--reverse'),
    release: argv.includes('--release'),
    buildOnly: argv.includes('--build-only'),
    acceptDeadProductionLiteral: argv.includes('--accept-dead-production-literal'),
    device,
  }).catch(
    (e) => {
      console.error(`[${device}] ${String(e.message || e)}`);
      process.exit(1);
    }
  );
}

export { toolchain, sitePort };

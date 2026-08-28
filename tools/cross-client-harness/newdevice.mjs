#!/usr/bin/env node
/**
 * TURNS A BROWSER PROFILE INTO A DEVICE THE SERVER HAS NEVER SEEN, and measures that it did.
 *
 *   node newdevice.mjs               HEAL-NEW-0: build the device and record the row
 *   node newdevice.mjs --keep-open   ... and leave the client logged in and unlocked for the
 *                                    caller, which is how the ten HEAL-NEW rows use it
 *   node newdevice.mjs --dry         read the profile and the census, change nothing
 *
 * WHY A PRIMITIVE, AND WHY IT IS MEASURED BEFORE ANY ROW RESTS ON IT. Eleven rows ask what a device
 * with NO local MLS state does when it meets an account that already has conversations - the user's
 * own report of conversations wearing a "Sync" badge, some repairing and some not, is exactly that
 * situation. None of the eleven existing HEAL rows reaches it: every one of them BREAKS a device that
 * already held the group (a snapshot rewind) or revokes one. A device that has never held anything is
 * a different mechanism - `discoverMissingGroups` enumerating the server's groups and rendering each
 * as a placeholder - and the rig had no way to produce one. This is that way.
 *
 * **WHAT MAKES A NEW DEVICE, exactly.** The web client's identity is one localStorage entry,
 * `mls_device_id_<userId>` (`BaseMlsService.rotateDeviceIdentity`), and its MLS state is IndexedDB.
 * The MLS credential is `userId:deviceId`, so a new id IS a new device and nothing of the old state
 * can be carried. Clearing the Canari ORIGIN therefore produces a genuinely new device rather than a
 * simulation of one - and it is the same wipe a person performs by opening a private window, which is
 * the shape the user asked for.
 *
 * **WHY THE ORIGIN AND NOT THE PROFILE.** The login hops canari-emse.fr -> auth.canari-emse.fr ->
 * cas.emse.fr, and CAS remembers a browser it has already challenged. Deleting the whole profile
 * throws that away too, so every row would pay the one step no tool here can answer - SETUP-4's 2FA -
 * and eleven rows would each need a human. Clearing ONE origin leaves the CAS and Authentik sessions
 * standing on their own origins, so the app is a new device while the browser is still a known
 * browser. **That is a claim, so it is an assertion here and not an assumption**:
 * `landedWithoutAHumanStep` fails the row if a credential step appears that `login.mjs` cannot answer.
 *
 * **IT IS DESTRUCTIVE, SO IT HAS AN ALLOWLIST** ([durable-rules](../../docs/wiki/durable-rules.md): a
 * destructive control needs an allowlist of what it may touch, not a denylist). Pointed at W1 this
 * would delete the owner client the whole campaign measures from, and pointed at W2 the peer. Only a
 * device named in `WIPEABLE` may be wiped, and naming one is a repository edit, not a flag.
 */
import { spawnSync } from "node:child_process";
import { census, isRegistered, userTag } from "./devices.mjs";
import { client, ensureChat } from "./chat.mjs";
import { evaluate, until } from "./cdp.mjs";
import { ORIGIN, PORTS } from "./names.mjs";
import { recordObserved } from "./results.mjs";
import { watch } from "./watch.mjs";

/**
 * Keys the app itself writes on a cold boot, which are therefore NOT survivors of a wipe.
 *
 * MEASURED on 2026-08-28 against this very device rather than reasoned about: clearing the origin
 * leaves localStorage at `[]`, and the reload performed below - done on purpose, so the wipe is read
 * against a fresh document instead of one still holding the app's in-memory copies - brings
 * PARAGLIDE_LOCALE back on its own. A locale is not an identity: no key material, no session, no
 * statement about who this browser belongs to.
 *
 * NAMES, NOT A COUNT, and an allowlist rather than a tolerance. The next key the app learns to write
 * on boot must surface as a name for someone to judge, not slip under a threshold that quietly moves
 * a verdict - which is the same reason a destructive control here carries an allowlist of what it may
 * touch instead of a denylist of what it may not.
 */
const WRITTEN_BY_THE_BOOT = new Set(["PARAGLIDE_LOCALE"]);

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const dry = argv.includes("--dry");
const keepOpen = argv.includes("--keep-open");

/**
 * THE ALLOWLIST. A scratch device exists to be wiped; W1 and W2 carry the history every other row is
 * measured against, and A1 is the one armed phone whose re-enrolment costs a 2FA.
 */
const WIPEABLE = ["W3"];
const device = opt("device", "W3");
if (!WIPEABLE.includes(device)) {
  throw new Error(
    `${device} is not wipeable - only ${WIPEABLE.join(", ")} may be. W1 and W2 hold the history every ` +
      "row is measured against, and A1 is the only armed phone. Add a scratch device instead.",
  );
}
if (!PORTS[device]) {
  throw new Error(
    `${device} is not declared: add PORTS.${device}, ACCOUNT_OF.${device} and ORIGIN.${device} to ` +
      "names.mjs in the STATE_DIR (gitignored), and to names.example.mjs in the repo. It must be the " +
      "OWNER account, because every HEAL-NEW row is about a second device of the person who owns the " +
      "conversations.",
  );
}
const port = PORTS[device];
const origin = ORIGIN[device];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const stage = (s) =>
  console.log(`[${String((Date.now() - T0) / 1000).padStart(7)}s] [newdevice] ${s}`);

/** Runs one of the rig's own tools and returns whether it succeeded, never its output. */
// THE STATUS, NOT A BOOLEAN. Collapsing every non-zero to `false` throws away the one thing that
// separates "the gate was not there" from "the gate refused us", and both then arrive at the verdict
// as the same missing tick. `pin.mjs` exits 2 for "no unlock modal on screen", which is an
// OBSERVATION about the product, not a failure of the rig - and read as a failure it took HEAL-NEW-0
// to FAIL on 2026-08-28 with every other expectation of the primitive true.
const run = (script, args) => {
  stage(`spawn ${script} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  return r.status;
};

/**
 * Everything the origin holds, as data. `indexedDB.databases()` is what proves the MLS store is gone
 * - localStorage being empty says nothing about it, and the store is where the state actually lives.
 */
const CENSUS_OF_ORIGIN = `(async function () {
  var dbs = [];
  try { dbs = (await indexedDB.databases()).map(function (d) { return d.name; }); } catch (e) { dbs = ['(unreadable: ' + e + ')']; }
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return JSON.stringify({
    localStorageKeys: keys,
    sessionStorageCount: sessionStorage.length,
    databases: dbs,
    cookieCount: document.cookie ? document.cookie.split(';').length : 0
  });
})()`;

const readOrigin = async (cx) => JSON.parse(await evaluate(cx, CENSUS_OF_ORIGIN));

/** The device id the web client is using, read from the one entry that carries it. */
const DEVICE_ID_NOW = `(function () {
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k.indexOf('mls_device_id_') === 0) return JSON.stringify({ userId: k.slice('mls_device_id_'.length), deviceId: localStorage.getItem(k) });
  }
  return 'null';
})()`;

/**
 * Makes `device` a device the server has never seen, and returns what it measured.
 *
 * Exported because the ten HEAL-NEW rows all begin here and differ only in WHO ELSE IS ONLINE while
 * it runs. Each of them owns its own assertions about the sidebar that comes back; this owns only the
 * claim that the thing looking at that sidebar really is a new device.
 */
export async function becomeANewDevice({ report = stage } = {}) {
  // The census BEFORE, so "the server has never seen this id" is a comparison and not a hope. It is
  // built from `key_package`, i.e. it holds every device that ever completed an enrolment - which is
  // exactly the population the claim is about.
  const today = new Date().toISOString().slice(0, 10);
  const knownBefore = new Set(census(today).map((r) => r.deviceId));
  report(`the server knows ${knownBefore.size} enrolled device(s) across the platform`);

  let cx = await client(port, "canari-emse.fr");
  const before = await readOrigin(cx);
  const wasRaw = await evaluate(cx, DEVICE_ID_NOW);
  const was = wasRaw === "null" ? null : JSON.parse(wasRaw);
  report(
    `before: ${before.localStorageKeys.length} localStorage key(s), ${before.databases.length} database(s), ` +
      `${before.cookieCount} readable cookie(s), device ${was ? was.deviceId : "(none)"} of ${was ? userTag(was.userId) : "(nobody)"}`,
  );

  if (dry) {
    report("--dry: the origin is left exactly as it is");
    return { dry: true, before, was, knownBefore: knownBefore.size };
  }

  // ONE CALL, AND IT IS THE BROWSER'S OWN. Deleting databases from page script races the app, which
  // reopens them the moment it notices - and a half-cleared IndexedDB is the one state that produces
  // a device wearing an old identity over an empty store, which is not what any row wants to measure.
  await cx.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  report(`cleared every storage type for ${origin}`);

  // A wipe verified on the SAME page is verified against a document that may still hold the app's
  // in-memory copies. Reload first, then read: what survives a reload is what really survived.
  await cx.send("Page.enable").catch(() => null);
  await evaluate(cx, `location.href = ${JSON.stringify(origin)}`);
  await sleep(6_000);
  cx.close();
  cx = await client(port, "canari-emse.fr");
  const after = await readOrigin(cx);
  // ASSERTED AGAINST IDENTITY, not against key count. Counting every key asserted against the rig's
  // own reload: it failed HEAL-NEW-0 and all four HEAL-REVOKE rows on 2026-08-28 naming
  // PARAGLIDE_LOCALE, while both MLS databases, every cookie and every identity-bearing key really
  // were gone. See WRITTEN_BY_THE_BOOT for what was measured.
  const identitySurvivors = after.localStorageKeys.filter((k) => !WRITTEN_BY_THE_BOOT.has(k));
  const nothingSurvivedTheWipe =
    identitySurvivors.length === 0 && after.databases.length === 0 && after.cookieCount === 0;
  report(
    `after the wipe: ${after.localStorageKeys.length} localStorage key(s) ${JSON.stringify(after.localStorageKeys).slice(0, 200)}, ` +
      `${after.databases.length} database(s) ${JSON.stringify(after.databases).slice(0, 200)}, ${after.cookieCount} cookie(s)`,
  );

  // The app must now be a stranger to this browser. Asserted, because a live session would make every
  // later observation a statement about a device that was never new.
  const loggedOut = await until(
    cx,
    `document.body.innerText.includes('Se connecter')`,
    30_000,
  ).then(
    () => true,
    () => false,
  );
  report(`the app shows the launcher: ${loggedOut}`);

  // THE LOGIN IS THE CLAIM BEING TESTED, NOT A SETUP STEP. If CAS challenges this browser, the
  // eleven rows each cost a human, and that has to be a measured fact rather than a discovery made
  // three rows in.
  const loginOk = run("login.mjs", ["--device", device]) === 0;
  const landedAt = await evaluate(cx, "location.href").catch(() => "(unreadable)");
  const landedOnTheApp =
    landedAt.includes("canari-emse.fr") && !landedAt.includes("auth.canari-emse.fr");
  const challenge = landedOnTheApp
    ? null
    : await evaluate(cx, `document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)`).catch(
        () => null,
      );
  const landedWithoutAHumanStep = loginOk && landedOnTheApp;
  report(
    `login ok=${loginOk}, landed on the app=${landedOnTheApp}${challenge ? ` - stuck at: ${challenge}` : ""}`,
  );

  // Observed from HERE, so the enrolment and the first discovery pass are inside the window. Earlier
  // would only capture the logged-out launcher; later would miss the lines every HEAL-NEW row reads.
  const observer = await watch(cx, device);

  // The PIN is account-level (`PinVerifier`, `POST /api/mls/security/pin-check`), so a new device
  // enters the SAME one - which is why this costs no human step either.
  //
  // WHETHER A GATE APPEARS AT ALL IS AN OBSERVATION, NOT THIS PRIMITIVE'S CLAIM. What the primitive
  // asserts is narrow and it is the thing nine rows rest on: this browser is now a device the server
  // has never seen, of the same account, enrolled, reached without a human. Whether the app also
  // challenges a brand-new device for the account PIN is a different question about the product, and
  // smuggling it in here answers it by accident - a fresh device that enrolled with no gate shown
  // would fail a row that never set out to ask, and the finding would arrive labelled as a broken
  // primitive rather than as the security question it is. Measured on 2026-08-28: no gate is shown.
  // Named, recorded, and left for a row of its own to judge.
  const pinStatus = landedWithoutAHumanStep ? run("pin.mjs", ["--device", device]) : null;
  const pinGate =
    pinStatus === null
      ? "not reached"
      : pinStatus === 0
        ? "answered"
        : pinStatus === 2
          ? "none shown"
          : `refused (exit ${pinStatus})`;
  const pinOk = pinStatus === 0 || pinStatus === 2;
  report(`the PIN gate: ${pinGate}`);
  await ensureChat(cx).catch(() => null);
  await sleep(8_000);

  const nowRaw = await evaluate(cx, DEVICE_ID_NOW);
  const now = nowRaw === "null" ? null : JSON.parse(nowRaw);
  report(
    `after enrolment: device ${now ? now.deviceId : "(none)"} of ${now ? userTag(now.userId) : "(nobody)"}`,
  );

  const aFreshIdWasMinted = !!now && (!was || now.deviceId !== was.deviceId);
  const theServerHadNeverSeenIt = !!now && !knownBefore.has(now.deviceId);
  const theSameAccountCameBack = !!now && !!was && now.userId === was.userId;

  // Enrolment is not the id existing locally: it is the server holding a record of it. On this
  // schema that record is an `auth_sessions` row and nothing else - there is no device registry.
  //
  // AND IT IS A FACT THAT ARRIVES, so it is waited for by proof rather than read once after a sleep.
  // The publication is asynchronous: this same code read `true` at +19.8 s on one run and `false` at
  // +20.7 s on the next - and the second device had ALREADY healed all ten of its sidebar rows, so
  // HEAL-NEW-2 failed on a race inside its own instrument while the product had done everything the
  // row asked. A single read after a fixed delay is a clock wearing a fact's clothes.
  //
  // THE DEADLINE IS A REPORTING BOUNDARY, NOT THE ANSWER. `enrolledInMs` reaches the ledger either
  // way, so a device that takes forty seconds to register is a finding carrying a number instead of
  // a silent tick - and this is one indexed query, cheap enough to ask again.
  //
  // AND THE POLL IS NOT WHAT WAS WRONG. Bounding the wait turned "it sometimes says no" into "it
  // says no for 63.7 s", which is what finally pointed at the predicate: the census reads
  // `key_package` UNION `dm_device_group_memberships`, so it asks whether a peer could ADDRESS this
  // device, never whether the device exists. A device that has published no KeyPackage is invisible
  // to it, and five HEAL-NEW rows failed on that while everything they were written to measure had
  // succeeded. `isRegistered` reads `auth_sessions`, the only row a registration writes on this
  // schema. Whether publication itself is late or absent is a SEPARATE question, and it is not this
  // primitive's to answer.
  const ENROLMENT_DEADLINE_MS = 60_000;
  let enrolled = false;
  let enrolledInMs = null;
  if (now) {
    const askedAt = Date.now();
    for (;;) {
      if (isRegistered(now.deviceId)) {
        enrolled = true;
        enrolledInMs = Date.now() - askedAt;
        break;
      }
      if (Date.now() - askedAt >= ENROLMENT_DEADLINE_MS) {
        enrolledInMs = Date.now() - askedAt;
        break;
      }
      await sleep(3000);
    }
  }
  report(
    `the server has a session for the new id: ${enrolled}` +
      (enrolledInMs === null ? "" : ` (after ${enrolledInMs}ms)`),
  );

  return {
    cx,
    observer,
    before,
    after,
    was,
    now,
    knownBefore: knownBefore.size,
    identitySurvivors,
    nothingSurvivedTheWipe,
    loggedOut,
    landedWithoutAHumanStep,
    challenge,
    pinGate,
    pinOk,
    aFreshIdWasMinted,
    theServerHadNeverSeenIt,
    theSameAccountCameBack,
    enrolled,
    enrolledInMs,
  };
}

// --- HEAL-NEW-0 ---------------------------------------------------------------------------------
// Run directly, this IS the row: it asserts the primitive rather than using it. Nine rows rest on
// every one of these facts, and a primitive believed rather than measured is how a whole rung's
// results end up describing the instrument.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (invokedDirectly) {
  const r = await becomeANewDevice();
  if (r.dry) {
    console.log(JSON.stringify({ dry: true, before: r.before, was: r.was }, null, 2));
    process.exit(0);
  }

  const ok =
    r.nothingSurvivedTheWipe &&
    r.loggedOut &&
    r.landedWithoutAHumanStep &&
    r.pinOk &&
    r.aFreshIdWasMinted &&
    r.theServerHadNeverSeenIt &&
    r.theSameAccountCameBack &&
    r.enrolled;

  console.log(
    `\n[newdevice] wipe=${r.nothingSurvivedTheWipe} loggedOut=${r.loggedOut} ` +
      `noHumanStep=${r.landedWithoutAHumanStep} pin=${r.pinGate} freshId=${r.aFreshIdWasMinted} ` +
      `neverSeen=${r.theServerHadNeverSeenIt} sameAccount=${r.theSameAccountCameBack} enrolled=${r.enrolled}`,
  );

  // `recordObserved` and NOT `finishObserved`: the latter calls `process.exit` itself, so the close
  // and the exit code below would both be dead code - and `--keep-open`, the whole reason the ten
  // rows can reuse this, would silently mean nothing.
  const row = await recordObserved(
    "HEAL-NEW-0",
    ok ? "PASS" : "FAIL",
    {
      device,
      origin,
      localStorageKeysBefore: r.before.localStorageKeys.length,
      databasesBefore: r.before.databases,
      localStorageKeysAfter: r.after.localStorageKeys,
      databasesAfter: r.after.databases,
      cookiesAfter: r.after.cookieCount,
      // The survivors BY NAME. `localStorageKeysAfter` says what was there; this says what of it the
      // row refused to excuse, so a future disagreement is readable off the ledger line alone.
      identitySurvivors: r.identitySurvivors,
      // The ids themselves, because "a fresh id" is a claim about two values and the ledger is
      // outside the repository precisely so it may hold them.
      abandonedDeviceId: r.was?.deviceId ?? null,
      newDeviceId: r.now?.deviceId ?? null,
      enrolledDevicesOnTheServerBefore: r.knownBefore,
      challenge: r.challenge,
      nothingSurvivedTheWipe: r.nothingSurvivedTheWipe,
      loggedOut: r.loggedOut,
      landedWithoutAHumanStep: r.landedWithoutAHumanStep,
      // BY NAME, so "no gate was shown" can never again read as "the gate refused us".
      pinGate: r.pinGate,
      pinOk: r.pinOk,
      aFreshIdWasMinted: r.aFreshIdWasMinted,
      theServerHadNeverSeenIt: r.theServerHadNeverSeenIt,
      theSameAccountCameBack: r.theSameAccountCameBack,
      enrolled: r.enrolled,
      // HOW LONG the key package took to appear. A number nobody had until it broke a row.
      enrolledInMs: r.enrolledInMs,
    },
    { [device]: r.observer },
  );

  if (!keepOpen) r.cx.close();
  process.exit(row.verdict === "PASS" ? 0 : 1);
}

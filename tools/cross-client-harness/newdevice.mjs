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
import {
  census,
  enrolledDeviceCount,
  hasKeyPackage,
  isRegistered,
  MAX_DEVICES_PER_USER,
  userTag,
} from "./devices.mjs";
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
 * Makes `device` a device the server has never seen, and RETURNS THE MOMENT THAT DEVICE IS LIVE.
 *
 * Exported because the ten HEAL-NEW rows all begin here and differ only in WHO ELSE IS ONLINE while
 * it runs. Each of them owns its own assertions about the sidebar that comes back; this owns only the
 * claim that the thing looking at that sidebar really is a new device.
 *
 * WHY IT STOPS AT `/chat` AND `confirmEnrolment` HOLDS THE REST - the design call of 2026-08-29, and
 * it is HEAL-NEW-15's whole subject. Everything that used to follow this point - an 8 s settle, the
 * `isRegistered`/`hasKeyPackage` poll against the database, the abandoned-id purge - is a `spawnSync`
 * or an `ssh`, so it BLOCKS THE EVENT LOOP: no concurrent reader can exist while it runs, and it ran
 * for about 49 s. The fresh device is live and healing throughout, which means the amber window a row
 * asks about lives INSIDE the mint and no sidebar reader could ever open on it. `dc8bf000` recorded
 * exactly that: the watch's first sample read 10 rows, 10 ready, 0 syncing, 49 s after the landing.
 *
 * So the mint is SPLIT at the live client. A row that has a question about the app WHILE it heals
 * asks it here, between the two halves; a row that has none calls them back to back and nothing about
 * what it asserts changes.
 *
 * THE REFUSAL PATH DOES NOT MOVE. `theAccountHadRoomForOneMore` is asserted BEFORE the wipe, because
 * after it there is no way back - it is the guard that protects the rung from the device cap, and a
 * guard that runs after the damage is not a guard.
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

  // THE ACCOUNT MUST HAVE ROOM BEFORE ANYTHING IS DESTROYED, and it is asked HERE because after the
  // wipe there is no way back: the old identity is gone and the new one cannot be registered, which
  // leaves the profile holding a session and no KeyPackage - addressable by nobody, and looking to
  // every row above like a product that does not heal. That is what happened on 2026-08-28.
  const spent = was ? enrolledDeviceCount(was.userId) : null;
  const theAccountHadRoomForOneMore = spent === null ? true : spent < MAX_DEVICES_PER_USER;
  report(
    `the account spends ${spent === null ? "(unknown)" : spent}/${MAX_DEVICES_PER_USER} device slot(s)` +
      (theAccountHadRoomForOneMore ? "" : " - FULL, and register-device answers a full account with a 400"),
  );
  if (!theAccountHadRoomForOneMore) {
    cx.close();
    return {
      refused: "the account is at the server's per-user device cap, so a new device cannot enrol",
      before,
      was,
      spent,
      knownBefore,
      theAccountHadRoomForOneMore,
    };
  }

  if (dry) {
    report("--dry: the origin is left exactly as it is");
    return { dry: true, before, was, spent, knownBefore };
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

  // THE HANDOVER POINT. From here the device is live on /chat and enumerating; `liveAt` is the origin
  // every later duration is measured from, and it is a wall stamp because the second half may run
  // after a caller has spent ten minutes watching the sidebar.
  const liveAt = Date.now();
  report("the client is LIVE on /chat - the mint hands over here");

  return {
    cx,
    observer,
    before,
    after,
    was,
    knownBefore,
    liveAt,
    identitySurvivors,
    nothingSurvivedTheWipe,
    loggedOut,
    landedWithoutAHumanStep,
    challenge,
    pinGate,
    pinOk,
    theAccountHadRoomForOneMore,
    spent,
  };
}

/**
 * The second half of the mint: what the SERVER says about the device that just went live.
 *
 * SPLIT OUT ON 2026-08-29 so a caller can put its own observation between the two - see
 * `becomeANewDevice` for why the split exists at all. Nothing here changed in substance; only WHEN it
 * runs, and therefore what its durations are evidence FOR.
 *
 * THE TIMINGS ARE A BOUND, AND THEY SAY SO IN THEIR NAMES. They used to be measured from the instant
 * the poll started, which was the instant the device went live - so `registeredInMs` really was the
 * enrolment latency. It no longer is: a row may watch its sidebar for ten minutes before calling
 * this, and the fact could have become true at any point in between. `registeredWithinMs` is
 * therefore "true no later than this many ms after the client went live", and
 * `registeredWasAlreadyTrue` says whether the very first read found it - which is exactly the case
 * where the number is a bound and nothing more. A COLUMN IS ONLY EVIDENCE FOR THE QUESTION IT WAS
 * WRITTEN TO ANSWER: the real enrolment latency belongs to HEAL-NEW-0, which calls the two halves
 * back to back and measures nothing in between.
 *
 * IT DRIVES A UI, SO IT MUST NOT RUN BESIDE AN OBSERVATION. `purge-devices.mjs` navigates this very
 * client to its device panel; a caller that runs this while a watch or a usability probe is live is
 * measuring a page the cleanup moved.
 */
export async function confirmEnrolment({
  cx,
  was,
  knownBefore,
  liveAt,
  port: devicePort = port,
  report = stage,
}) {
  await sleep(8_000);

  const nowRaw = await evaluate(cx, DEVICE_ID_NOW);
  const now = nowRaw === "null" ? null : JSON.parse(nowRaw);
  report(
    `after enrolment: device ${now ? now.deviceId : "(none)"} of ${now ? userTag(now.userId) : "(nobody)"}`,
  );

  const aFreshIdWasMinted = !!now && (!was || now.deviceId !== was.deviceId);
  const theServerHadNeverSeenIt = !!now && !knownBefore.has(now.deviceId);
  const theSameAccountCameBack = !!now && !!was && now.userId === was.userId;

  // ENROLMENT IS TWO SERVER FACTS, AND THE PAIR IS THE DIAGNOSIS. A session is written by the OIDC
  // callback; a KeyPackage is written by `POST /api/mls/register-device`. Only the second makes the
  // device ADDRESSABLE - the server refuses to activate a membership without one
  // (`[MEMBERSHIP_ACTIVE] REFUSED reason=no_key_package`) - so it is the fact every HEAL row rests on.
  // Reading one of them alone is what turned a plain refusal into a phantom product defect on
  // 2026-08-28: session yes, KeyPackage no is not "publication is slow", it is "the registration was
  // REFUSED", and the server had logged the reason all along.
  //
  // AND IT IS A FACT THAT ARRIVES, so it is waited for by proof rather than read once after a sleep.
  // THE DEADLINE IS A REPORTING BOUNDARY, NOT THE ANSWER: both elapsed times reach the ledger, so a
  // device that takes forty seconds is a finding carrying a number instead of a silent tick. The
  // deadline is counted from the first read, because it bounds THIS WAIT; the reported figures are
  // counted from `liveAt`, because that is the only instant they are a statement about the device.
  const ENROLMENT_DEADLINE_MS = 60_000;
  let registered = false;
  let addressable = false;
  let registeredWithinMs = null;
  let addressableWithinMs = null;
  let registeredWasAlreadyTrue = null;
  let addressableWasAlreadyTrue = null;
  if (now) {
    const askedAt = Date.now();
    for (let read = 0; ; read += 1) {
      if (!registered && isRegistered(now.deviceId)) {
        registered = true;
        registeredWithinMs = Date.now() - liveAt;
        registeredWasAlreadyTrue = read === 0;
      }
      if (hasKeyPackage(now.deviceId)) {
        addressable = true;
        addressableWithinMs = Date.now() - liveAt;
        addressableWasAlreadyTrue = read === 0;
        break;
      }
      if (Date.now() - askedAt >= ENROLMENT_DEADLINE_MS) break;
      await sleep(3000);
    }
  }
  const enrolled = registered && addressable;
  // THE PRIMITIVE CLEANS UP AFTER ITSELF, because its debris is what broke the rung. Every mint
  // abandons an id that still spends one of the account's fifteen slots, so a sixteen-row rung fills
  // the cap by construction - and the sixteenth row then measures a refusal instead of the product.
  // Purging the id THIS call abandoned keeps the account at a steady two or three devices, which is
  // also what makes consecutive rows comparable: they each meet an account of the same shape.
  //
  // AN ALLOWLIST OF EXACTLY ONE, and it is named by measurement rather than by position: the id read
  // off this profile before the wipe. It runs AFTER the new device is addressable, so a failure here
  // costs a slot and never the row.
  //
  // AND IT PURGES THROUGH THE DEVICE IT JUST ENROLLED, not through W1. `purge-devices.mjs` drives a
  // device PANEL, so it needs a LIVE client of this account - and naming W1 made the cleanup depend
  // on a browser the calling row may have deliberately killed. HEAL-NEW-2 does exactly that (its
  // premise is that no device of ours is online), so its purge died on
  // `ECONNREFUSED 127.0.0.1:9224` and the slot stayed spent. **The failure is SILENT by design** -
  // it costs a slot and never the verdict - so a rung of such rows walks into the fifteen-device cap
  // with nothing objecting, which is how 15/15 was reached once already. The device this call just
  // enrolled is the one client it can prove is up, and it is on the right account by construction.
  let abandonedPurged = null;
  if (was && enrolled && was.deviceId !== now.deviceId) {
    const status = run("purge-devices.mjs", ["--only", was.deviceId, "--port", String(devicePort)]);
    abandonedPurged = status === 0;
    report(
      `the id this mint abandoned (...${was.deviceId.slice(-13)}) was purged: ${abandonedPurged}` +
        (abandonedPurged ? "" : " - a slot stays spent, and the cap is one row closer"),
    );
  }

  // A BOUND IS SAID TO BE A BOUND. "within 61s of going live, and it was already true when asked" is
  // a different sentence from "it took 61s", and only the first one is what this call can know.
  const bound = (ms, alreadyTrue) =>
    ms === null
      ? ""
      : ` (within ${ms}ms of the client going live${alreadyTrue ? ", ALREADY true at the first read" : ""})`;
  report(
    `the server has a session for the new id: ${registered}${bound(registeredWithinMs, registeredWasAlreadyTrue)}` +
      `, and a published KeyPackage: ${addressable}${bound(addressableWithinMs, addressableWasAlreadyTrue)}` +
      (registered && !addressable
        ? " - A SESSION WITHOUT A KEYPACKAGE MEANS register-device REFUSED IT; read the server's line"
        : ""),
  );

  return {
    now,
    aFreshIdWasMinted,
    theServerHadNeverSeenIt,
    theSameAccountCameBack,
    registered,
    registeredWithinMs,
    registeredWasAlreadyTrue,
    addressable,
    addressableWithinMs,
    addressableWasAlreadyTrue,
    abandonedPurged,
    enrolled,
  };
}

/**
 * The two halves back to back, for a caller with no question to ask in between.
 *
 * Every caller but HEAL-NEW-15 is one of those, and threading `cx`, `was`, `knownBefore` and `liveAt`
 * from one call into the next at each site is four chances for them to drift apart. A refusal or a
 * `--dry` never reaches the second half: there is no live client to ask about.
 */
export async function becomeANewDeviceAndConfirm({ report = stage } = {}) {
  const minted = await becomeANewDevice({ report });
  if (minted.refused || minted.dry) return minted;
  return { ...minted, ...(await confirmEnrolment({ ...minted, report })) };
}

// --- HEAL-NEW-0 ---------------------------------------------------------------------------------
// Run directly, this IS the row: it asserts the primitive rather than using it. Nine rows rest on
// every one of these facts, and a primitive believed rather than measured is how a whole rung's
// results end up describing the instrument.
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (invokedDirectly) {
  // BACK TO BACK, so what this row asserts did not change when the mint was split - and so the
  // durations it records really are the enrolment latency: nothing runs between the two halves here.
  const r = await becomeANewDeviceAndConfirm();
  if (r.dry) {
    console.log(JSON.stringify({ dry: true, before: r.before, was: r.was, spent: r.spent }, null, 2));
    process.exit(0);
  }
  // REFUSED BEFORE THE WIPE IS NOT A VERDICT ABOUT THE PRODUCT, so it does not become one. The
  // account being full is a fact about the rig's own debris, and recording a FAIL here would put the
  // campaign's housekeeping on the board as a defect.
  if (r.refused) {
    console.error(`\n[newdevice] REFUSED - ${r.refused} (${r.spent}/${MAX_DEVICES_PER_USER})`);
    console.error(
      `[newdevice] purge the abandoned mints first: node purge-devices.mjs --dry --port ${port}`,
    );
    process.exit(3);
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
      `neverSeen=${r.theServerHadNeverSeenIt} sameAccount=${r.theSameAccountCameBack} ` +
      `registered=${r.registered} addressable=${r.addressable}`,
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
      enrolledDevicesOnTheServerBefore: r.knownBefore.size,
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
      // HOW LONG the two server facts took to appear, each beside whether the first read already
      // found it. `enrolledInMs` stood here until 2026-08-29 and NOTHING HAS EVER SET IT: the key
      // was never returned by anything, so the ledger carried `null` under a name that reads like a
      // measurement. These two are the fields that exist - and on this row, where the halves run back
      // to back, "within N ms of going live" is the enrolment latency itself.
      registeredWithinMs: r.registeredWithinMs,
      registeredWasAlreadyTrue: r.registeredWasAlreadyTrue,
      addressableWithinMs: r.addressableWithinMs,
      addressableWasAlreadyTrue: r.addressableWasAlreadyTrue,
    },
    { [device]: r.observer },
  );

  if (!keepOpen) r.cx.close();
  process.exit(row.verdict === "PASS" ? 0 : 1);
}

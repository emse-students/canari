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
import { census, userTag } from "./devices.mjs";
import { client, ensureChat } from "./chat.mjs";
import { evaluate, until } from "./cdp.mjs";
import { ORIGIN, PORTS } from "./names.mjs";
import { recordObserved } from "./results.mjs";
import { watch } from "./watch.mjs";

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
const run = (script, args) => {
  stage(`spawn ${script} ${args.join(" ")}`);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  return r.status === 0;
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
  const nothingSurvivedTheWipe =
    after.localStorageKeys.length === 0 && after.databases.length === 0 && after.cookieCount === 0;
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
  const loginOk = run("login.mjs", ["--device", device]);
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
  const pinOk = landedWithoutAHumanStep && run("pin.mjs", ["--device", device]);
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

  // Enrolment is not the id existing locally: it is the key package the server stores, which is what
  // makes this device addressable by every other member. The census is the only place that says so.
  const enrolled = !!now && census(today).some((r) => r.deviceId === now.deviceId);
  report(`the census now carries the new id: ${enrolled}`);

  return {
    cx,
    observer,
    before,
    after,
    was,
    now,
    knownBefore: knownBefore.size,
    nothingSurvivedTheWipe,
    loggedOut,
    landedWithoutAHumanStep,
    challenge,
    pinOk,
    aFreshIdWasMinted,
    theServerHadNeverSeenIt,
    theSameAccountCameBack,
    enrolled,
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
      `noHumanStep=${r.landedWithoutAHumanStep} pin=${r.pinOk} freshId=${r.aFreshIdWasMinted} ` +
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
      // The ids themselves, because "a fresh id" is a claim about two values and the ledger is
      // outside the repository precisely so it may hold them.
      abandonedDeviceId: r.was?.deviceId ?? null,
      newDeviceId: r.now?.deviceId ?? null,
      enrolledDevicesOnTheServerBefore: r.knownBefore,
      challenge: r.challenge,
      nothingSurvivedTheWipe: r.nothingSurvivedTheWipe,
      loggedOut: r.loggedOut,
      landedWithoutAHumanStep: r.landedWithoutAHumanStep,
      pinOk: r.pinOk,
      aFreshIdWasMinted: r.aFreshIdWasMinted,
      theServerHadNeverSeenIt: r.theServerHadNeverSeenIt,
      theSameAccountCameBack: r.theSameAccountCameBack,
      enrolled: r.enrolled,
    },
    { [device]: r.observer },
  );

  if (!keepOpen) r.cx.close();
  process.exit(row.verdict === "PASS" ? 0 : 1);
}

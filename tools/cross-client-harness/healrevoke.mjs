#!/usr/bin/env node
/**
 * THE REVOKED DEVICE THAT COMES BACK AFTER THE WORLD MOVED - one runner, one row per invocation.
 *
 *   node healrevoke.mjs --row 5                  revoked, the world changes a lot, then it returns
 *   node healrevoke.mjs --row 7 --order first    it returns BEFORE the other devices are online
 *   node healrevoke.mjs --row 7 --order last     it returns AFTER they are
 *   node healrevoke.mjs --row 8                  a group DELETED while it was away
 *
 * THE ASSERTION IS AN EQUALITY, NOT A REPAIR COUNT (user, 2026-08-27). Revocation orders the device
 * to delete everything, so a revoked device coming back IS a new device - and if that is true, its
 * final state must equal a fresh device's in the same world. Ending with MORE than the fresh device
 * means the wipe kept something; ending with LESS is worse, because a device missing a group it is
 * still a member of looks healthy and is not.
 *
 * THE REFERENCE IS MEASURED, NEVER LOOKED UP. The fresh device it is compared against is minted HERE,
 * on the same profile, in the same world, minutes later - not read out of a HEAL-NEW row taken at
 * another hour against another set of groups. Two fingerprints from the same afternoon are a
 * comparison; one fingerprint and a remembered number is a hope. It costs a second enrolment, which
 * is affordable exactly because the PIN is account-level and the CAS session survives the wipe.
 *
 * WHY THE MISSED CHANGES CANNOT BE A QUEUE DRAIN. A message the device missed is a ciphertext someone
 * can hand it again. A MEMBERSHIP change is an epoch move: the group's ratchet advanced without this
 * device, and no replay puts it back - the only way in is a fresh Welcome or an external join. So the
 * world this row moves is deliberately made of both kinds: a group created, a group deleted, and
 * messages sent. A runner that only sent messages would pass while the mechanism that matters was
 * never exercised.
 *
 * IT REVOKES THROUGH THE PRODUCT'S OWN PATH. `purge-devices.mjs` drives the device panel, so the
 * DELETE that runs is the one a person triggers, with `purgeDeviceFootprint` behind it. A row that
 * deleted a row from the database would be measuring a state the product never produces, and the
 * question here is what the product does.
 *
 * ORDER IS AN AXIS HERE TOO, for the same reason it is for HEAL-NEW: the returning device may find
 * the account's other clients already listening, or arrive alone and be found later. Those are two
 * mechanisms, and row 7 asserts the FINAL STATE is the same across both while recording the time
 * separately, because a difference in time is dirt carrying a number and a difference in state is a
 * failure.
 *
 * NO NAMES. Groups this runner mints are named on `debris.mjs`'s existing `HGRP` pattern so the
 * sweeps can already reach them; nothing else about a conversation is ever printed, and ids are cut
 * to eight characters.
 */
import { spawnSync } from "node:child_process";
import { client, ensureChat, evaluate } from "./chat.mjs";
import { census, installTag } from "./devices.mjs";
import { createGroup, deleteGroup } from "./groupnav.mjs";
import { isUp, killBrowser, startBrowser } from "./launch.mjs";
import { ORIGIN, PORTS, SITE } from "./names.mjs";
import { becomeANewDevice } from "./newdevice.mjs";
import { onlineDevicesOf } from "./presence.mjs";
import { record, unmet } from "./results.mjs";
import { navigationCost, readAll, watch as watchRows, whoAmI } from "./syncrows.mjs";
import { report, watch } from "./watch.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/** The device this row revokes. It must be the scratch profile: revoking W1 ends the campaign. */
const VICTIM = "W3";
/** The device that does the revoking, and that moves the world while the victim is away. */
const ACTOR = "W1";

const ROWS = {
  5: { id: "HEAL-REVOKE-5", what: "revoked, the world changes a lot, then it returns" },
  7: { id: "HEAL-REVOKE-7", what: "the ORDER of the return", orders: ["first", "last"] },
  8: { id: "HEAL-REVOKE-8", what: "a group deleted while the device was revoked" },
};

const row = ROWS[opt("row", "")];
if (!row) {
  console.error(`healrevoke: --row must be one of ${Object.keys(ROWS).join(", ")}`);
  process.exit(2);
}
const order = opt("order", row.orders ? null : "last");
if (row.orders && !row.orders.includes(order)) {
  console.error(`healrevoke: ${row.id} needs --order ${row.orders.join("|")}`);
  process.exit(2);
}

/** How long the returning device may take to settle before the stall IS the measurement. */
const SETTLE_MS = Number(opt("settle", "600")) * 1000;

const T0 = Date.now();
const mark = (what) => ({ what, at: Date.now() - T0, wall: new Date().toISOString() });
const timeline = [mark("start")];
const note = (what) => {
  const m = mark(what);
  timeline.push(m);
  console.log(`[healrevoke:${row.id}] +${(m.at / 1000).toFixed(1)}s ${what}`);
  return m;
};

/** An error's first line only: a stack in a ledger detail is noise nobody reads. */
const firstLine = (e) =>
  String(e?.message ?? e)
    .split(/\r?\n/)[0]
    .slice(0, 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs one rig script and reports its exit and last line, never its whole output. */
function runScript(file, args) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    cwd: import.meta.dirname,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n");
  return { ok: r.status === 0, status: r.status, tail: out.at(-1) ?? "" };
}

/**
 * A group name on `debris.mjs`'s EXISTING pattern, so a group this row abandons is already sweepable.
 *
 * A new pattern would mean a group nobody can delete until someone remembers to add it - which is
 * how twenty-two renamed groups sat invisible to both sweeps for days. `HGRP` plus five base-36
 * characters is `heal-w2.mjs`'s spelling and `isGroupDebris` already matches it.
 */
const debrisName = () => `HGRP${Math.random().toString(36).slice(2, 7)}`;

/** Puts the two peer browsers where this row needs them, and says what it actually did. */
async function setTopology(present) {
  const acted = {};
  for (const which of ["w1", "w2"]) {
    const wanted = present.includes(which);
    const up = await isUp(which);
    if (wanted && !up) {
      await startBrowser(which, `${SITE}/chat`);
      acted[which] = "started";
      runScript("pin.mjs", ["--device", which.toUpperCase()]);
    } else if (!wanted && up) {
      acted[which] = `killed in ${await killBrowser(which)}ms`;
    } else {
      acted[which] = up ? "already up" : "already down";
    }
  }
  return acted;
}

/** A connection to the victim's browser, whatever state its page is in. */
const victimCx = () => client(PORTS[VICTIM], new URL(ORIGIN[VICTIM]).hostname);

/**
 * Whether the sidebar holds a row with this exact name, and whether that row is ready.
 *
 * ONE NAME IN, A BOOLEAN OUT. The rig may not dump row text - the sidebar is a real person's
 * conversation list - but asking after a group this runner minted itself leaks nothing: the name was
 * generated here, and the answer is two bits.
 */
async function rowNamed(cx, name) {
  const raw = await evaluate(
    cx,
    `(function () {
       var want = ${JSON.stringify(name)};
       var tiles = [].slice.call(document.querySelectorAll('.sidebar-panel [data-conversation-tile]'));
       var hit = tiles.filter(function (t) { return t.innerText.indexOf(want) !== -1; });
       return JSON.stringify({
         present: hit.length > 0,
         count: hit.length,
         ready: hit.some(function (t) { return t.getAttribute('data-ready') === 'true'; }),
         syncing: hit.some(function (t) { return t.getAttribute('data-ready') === 'false'; }),
       });
     })()`,
  );
  return JSON.parse(raw);
}

/**
 * Revokes the victim through the device panel, and proves the server agrees it is gone.
 *
 * THE CENSUS IS THE PROOF, not the panel's own animation: `purge-devices.mjs` reports what it
 * clicked, and a click that opened a confirm nobody answered reports exactly the same thing. The
 * census reads `key_package`, so a device absent from it is a device no member can address any more -
 * which is what revocation has to mean before anything below is worth measuring.
 */
async function revoke(deviceId) {
  const today = new Date().toISOString().slice(0, 10);
  const carries = () => census(today).some((r) => r.deviceId === deviceId);
  const before = carries();
  const r = runScript("purge-devices.mjs", ["--only", deviceId, "--port", String(PORTS[ACTOR])]);

  // WAITED FOR, NOT READ ONCE. The mirror of the same fault on the minting side, which cost
  // HEAL-NEW-2 a FAIL on 2026-08-28: the key package's PUBLICATION is asynchronous, so its DELETION
  // is not something to assume synchronous with a click returning either. A single read here would
  // report a revocation that had not landed yet as a revocation that failed - and this is the gate
  // every row below stands on, so it would kill all four of them with one number.
  //
  // The wait is bounded and the elapsed time is returned, so a slow revocation is a finding with a
  // number rather than a silent tick. It ends on the proof - the census no longer carries the id.
  const askedAt = Date.now();
  let after = true;
  let goneInMs = null;
  for (;;) {
    after = carries();
    if (!after) {
      goneInMs = Date.now() - askedAt;
      break;
    }
    if (Date.now() - askedAt >= 45_000) {
      goneInMs = Date.now() - askedAt;
      break;
    }
    await sleep(3000);
  }
  return { wasEnrolled: before, stillEnrolled: after, goneInMs, script: r };
}

/**
 * What the victim's own console said about being revoked.
 *
 * The three discovery paths (`sessionAuth.ts`: the PIN check at login, a `device_revoked` frame on a
 * live session, a vault login asking the server) all end in `wipeRevokedDevice`, whose lines are
 * `[SECURITY] Revoked device detected` and `[RESET] done`. Which one fired is not asserted - a live
 * session should take the frame path, but a row that DEMANDED it would fail on a perfectly correct
 * wipe discovered a second later at the PIN gate. What is asserted is that a wipe happened at all.
 */
function classifyWipe(lines) {
  const said = (re) => lines.some((l) => re.test(l));
  return {
    revocationSeen: said(/Revoked device detected|device_revoked/i),
    wipeRan: said(/\[RESET\] wiping this device/),
    wipeFinished: said(/\[RESET\] done/),
    wipeIncomplete: said(/\[RESET\] finished with \d+ step\(s\) unfinished/),
    stepsFailed: lines.filter((l) => /\[RESET\] could not clear/.test(l)).length,
  };
}

/**
 * Brings the victim back: log in, enter the PIN, wait for the list to appear, watch it settle.
 *
 * It does NOT wipe anything - the point of the row is that REVOCATION did the wiping. If a store
 * survived, this is where it shows, and clearing the origin first would delete the evidence.
 */
async function comeBack(label) {
  note(`${label}: logging the revoked device back in`);
  const login = runScript("login.mjs", ["--device", VICTIM]);
  note(`${label}: login ${JSON.stringify(login)}`);
  const cx = await victimCx();
  const observer = await watch(cx, VICTIM);
  const pin = runScript("pin.mjs", ["--device", VICTIM]);
  note(`${label}: pin ${JSON.stringify(pin)}`);
  await ensureChat(cx).catch(() => null);
  const who = await whoAmI(cx);
  note(`${label}: it is now device ${who.deviceId?.slice(0, 8)} of ${who.userId?.slice(0, 8)}`);
  const w = await watchRows(cx, { timeoutMs: SETTLE_MS, log: (m) => console.log(m) });
  note(
    `${label}: ${w.settled ? `settled in ${w.elapsedMs}ms` : `still syncing after ${w.elapsedMs}ms`}`,
  );
  const last = await readAll(cx);
  return { cx, observer, login, pin, who, watch: w, last };
}

/**
 * The fingerprint two states are compared on: counts and the server's own view, never names.
 *
 * `serverActive` is in it deliberately. Two sidebars of nine rows are not equal if the server thinks
 * one device is a member of nine groups and the other of eleven - the screens would agree while the
 * devices did not, and it is the second number that says which one is wrong.
 */
const fingerprint = (readout) => ({
  rows: readout.rows.rows,
  ready: readout.rows.ready,
  syncing: readout.rows.syncing,
  removed: readout.rows.removed,
  unhooked: readout.rows.unhooked,
  serverActive: readout.server.active ?? null,
  serverDismissedStillMember: readout.server.dismissedStillMember ?? null,
});

/** The named differences between two fingerprints, so a FAIL says WHICH number moved. */
const differences = (a, b) =>
  Object.keys(a)
    .filter((k) => a[k] !== b[k])
    .map((k) => `${k}: ${a[k]} vs ${b[k]}`);

// ---------------------------------------------------------------------------------------------
// ONE NAMED STARTING POINT (user, 2026-08-25). The victim must be an ENROLLED device holding real
// state before it can be revoked, and "whatever it was doing" is not a starting point. So it is
// minted fresh here: after this, the victim is a device the server has just accepted, with the
// account's groups healed into it - which is the only state from which "it was revoked and came
// back" means anything.
// ---------------------------------------------------------------------------------------------
note(`starting point: minting an enrolled ${VICTIM} for the revocation to take away`);
const seeded = await becomeANewDevice({ report: (s) => note(`newdevice: ${s}`) });
note(
  `seed ${JSON.stringify({
    freshId: seeded.aFreshIdWasMinted,
    enrolled: seeded.enrolled,
    pinOk: seeded.pinOk,
  })}`,
);
if (!seeded.enrolled || !seeded.pinOk) {
  record(row.id, "INVALID", {
    unobservable:
      "the victim could not be brought to an enrolled starting point, so there is nothing to revoke",
    seed: { enrolled: seeded.enrolled, pinOk: seeded.pinOk, login: seeded.landedWithoutAHumanStep },
    what: row.what,
    timeline,
  });
  seeded.cx.close();
  process.exit(1);
}

// The victim's own console, from before the revocation, so the wipe's lines are inside the window.
const seedObserver = seeded.observer;
const seedSettle = await watchRows(seeded.cx, { timeoutMs: SETTLE_MS, log: (m) => console.log(m) });
note(
  `the seeded device ${seedSettle.settled ? "settled" : "did NOT settle"} in ${seedSettle.elapsedMs}ms`,
);
const seedState = fingerprint(await readAll(seeded.cx));
note(`seeded state ${JSON.stringify(seedState)}`);

// A group the victim HOLDS before it is revoked, and that will be deleted while it is away. Row 8's
// whole subject; created for every row because "did a doomed group come back" is worth knowing in all
// of them, and one group costs nothing.
const actorCx = await client(PORTS[ACTOR], new URL(ORIGIN[ACTOR]).hostname);
const actorObserver = await watch(actorCx, ACTOR);
await ensureChat(actorCx);
const doomed = debrisName();
note(`${ACTOR} creates ${doomed} - the group that will be deleted while the victim is away`);
await createGroup(actorCx, doomed, { label: "healrevoke" });

// The victim must actually HOLD it, or "it did not come back" proves nothing.
let heldTheDoomedGroup = false;
for (let i = 0; i < 40 && !heldTheDoomedGroup; i += 1) {
  heldTheDoomedGroup = (await rowNamed(seeded.cx, doomed)).ready;
  if (!heldTheDoomedGroup) await sleep(3000);
}
note(`the victim holds ${doomed}: ${heldTheDoomedGroup}`);

const victimBefore = await whoAmI(seeded.cx);
note(`the victim is device ${victimBefore.deviceId?.slice(0, 8)}`);

// ---------------------------------------------------------------------------------------------
// THE REVOCATION
// ---------------------------------------------------------------------------------------------
note("revoking the victim from the device panel, through the product path");
const revocation = await revoke(victimBefore.deviceId);
note(`revocation ${JSON.stringify(revocation)}`);

// The victim is live, so it should learn this from a frame rather than at a login gate. Either is
// accepted; what is waited for is the wipe.
let wipe = { revocationSeen: false, wipeRan: false, wipeFinished: false };
for (let i = 0; i < 30; i += 1) {
  const seen = await report(seedObserver);
  wipe = classifyWipe(seen.lines ?? []);
  if (wipe.wipeFinished || wipe.wipeIncomplete) break;
  await sleep(4000);
}
note(`the victim's own account of the wipe ${JSON.stringify(wipe)}`);
seeded.cx.close();

// ---------------------------------------------------------------------------------------------
// THE WORLD MOVES. Both KINDS of change, because they are repaired by different mechanisms: a
// deletion and a creation are epoch moves no replay can deliver, a message is a ciphertext that can
// be handed over again.
// ---------------------------------------------------------------------------------------------
const born = debrisName();
note(`${ACTOR} creates ${born} while the victim is revoked`);
await createGroup(actorCx, born, { label: "healrevoke" });
note(`${ACTOR} deletes ${doomed} while the victim is revoked`);
const deleted = await deleteGroup(actorCx, doomed).then(
  () => true,
  (e) => {
    note(`deleting ${doomed} threw: ${firstLine(e)}`);
    return false;
  },
);
note(`${doomed} deleted: ${deleted}`);

// ---------------------------------------------------------------------------------------------
// THE RETURN, in the order the row asks for.
// ---------------------------------------------------------------------------------------------
const returnTopology = row.id === "HEAL-REVOKE-7" && order === "first" ? [] : [ACTOR.toLowerCase()];
note(`the return happens with ${returnTopology.join(",") || "nothing"} online`);
const topology = await setTopology(returnTopology);
note(`topology ${JSON.stringify(topology)}`);

const back = await comeBack("return");
const returnedState = fingerprint(back.last);
note(`returned state ${JSON.stringify(returnedState)}`);
const doomedAfterReturn = await rowNamed(back.cx, doomed);
const bornAfterReturn = await rowNamed(back.cx, born);
note(
  `after the return: ${doomed} ${JSON.stringify(doomedAfterReturn)}, ${born} ${JSON.stringify(bornAfterReturn)}`,
);
const usability = await navigationCost(back.cx);
note(`usability ${JSON.stringify(usability)}`);
const backReport = await report(back.observer);
back.cx.close();

// ---------------------------------------------------------------------------------------------
// THE REFERENCE: a genuinely fresh device, same profile, same world, minutes later. Measured rather
// than looked up, because the number this is compared against has to describe THIS world.
// ---------------------------------------------------------------------------------------------
note("minting a fresh device as the reference the returned device must equal");
const fresh = await becomeANewDevice({ report: (s) => note(`reference: ${s}`) });
const freshSettle = await watchRows(fresh.cx, { timeoutMs: SETTLE_MS, log: (m) => console.log(m) });
note(
  `the reference ${freshSettle.settled ? "settled" : "did NOT settle"} in ${freshSettle.elapsedMs}ms`,
);
const freshState = fingerprint(await readAll(fresh.cx));
note(`reference state ${JSON.stringify(freshState)}`);
const doomedOnFresh = await rowNamed(fresh.cx, doomed);
const bornOnFresh = await rowNamed(fresh.cx, born);
note(
  `on the reference: ${doomed} ${JSON.stringify(doomedOnFresh)}, ${born} ${JSON.stringify(bornOnFresh)}`,
);
const freshReport = await report(fresh.observer);
fresh.cx.close();

const gap = differences(returnedState, freshState);

// ---------------------------------------------------------------------------------------------
const expectations = {
  /** The starting point was real: an enrolled device that had actually healed. */
  theVictimHeldTheWorldFirst: seedSettle.settled === true && heldTheDoomedGroup === true,
  /** Revocation reached the server: the census no longer carries the id. */
  theServerForgotTheDevice: revocation.wasEnrolled === true && revocation.stillEnrolled === false,
  /** The device obeyed: it said so, and it finished. */
  theDeviceWipedItself: wipe.wipeRan === true && wipe.wipeFinished === true,
  noWipeStepFailed: wipe.wipeIncomplete !== true && wipe.stepsFailed === 0,
  /** It came back as a device the server had never seen - a revoked id must not be reusable. */
  itReturnedAsANewDevice: !!back.who.deviceId && back.who.deviceId !== victimBefore.deviceId,
  itReturnedAsTheSamePerson: back.who.userId === victimBefore.userId,
  /** THE ROW'S POINT: it ended where a fresh device ends. */
  itEndedWhereAFreshDeviceEnds: gap.length === 0,
  /** Both actually finished. An equality between two stalls is not the equality being claimed. */
  bothSettled: back.watch.settled === true && freshSettle.settled === true,
  /** The group deleted while it was away is gone from BOTH, and gone the same way. */
  theDeletedGroupDidNotComeBack: doomedAfterReturn.present === false,
  theDeletedGroupIsAbsentFromTheReferenceToo: doomedOnFresh.present === false,
  /** The group created while it was away arrived on both. */
  theNewGroupArrived: bornAfterReturn.ready === true,
  theNewGroupArrivedOnTheReferenceToo: bornOnFresh.ready === true,
  /** The app was navigable while it healed - the second half of the user's question. */
  navigableWhileHealing: usability?.openedInMs != null,
  /** Every sample carries both clocks, which is what makes a stall diagnosable off-machine. */
  timelineIsStamped: timeline.every((m) => typeof m.at === "number" && typeof m.wall === "string"),
};

// Row 8 is the deletion row, so its own subject must have been set up: a deletion that never
// happened cannot be shown not to come back, and a PASS there would be vacuous.
if (row.id === "HEAL-REVOKE-8") expectations.theDeletionActuallyHappened = deleted === true;

const missing = unmet(expectations);
const verdict = missing.length === 0 ? "PASS" : "FAIL";

record(row.id, verdict, {
  what: row.what,
  order,
  seed: {
    deviceId: victimBefore.deviceId,
    settledInMs: seedSettle.settled ? seedSettle.elapsedMs : null,
    state: seedState,
    heldTheDoomedGroup,
  },
  revocation,
  wipe,
  world: { created: born, deleted: doomed, deletionSucceeded: deleted },
  returned: {
    deviceId: back.who.deviceId,
    settledInMs: back.watch.settled ? back.watch.elapsedMs : null,
    stalledForMs: back.watch.settled ? null : back.watch.elapsedMs,
    state: returnedState,
    samples: back.watch.samples,
    doomedGroup: doomedAfterReturn,
    newGroup: bornAfterReturn,
  },
  reference: {
    deviceId: fresh.now?.deviceId ?? null,
    settledInMs: freshSettle.settled ? freshSettle.elapsedMs : null,
    state: freshState,
    samples: freshSettle.samples,
    doomedGroup: doomedOnFresh,
    newGroup: bornOnFresh,
  },
  // The whole verdict of the row, in one field: which number differs between a returned device and a
  // fresh one. Empty is the PASS.
  equalityGap: gap,
  usability,
  topology,
  fleetAtTheEnd: (() => {
    try {
      return onlineDevicesOf(victimBefore.userId).map(installTag);
    } catch (e) {
      return [`unreadable: ${firstLine(e)}`];
    }
  })(),
  timeline,
  unmet: missing,
  clean: backReport.clean && freshReport.clean,
  observers: { victim: backReport, reference: freshReport, actor: await report(actorObserver) },
});
actorCx.close();
process.exit(verdict === "PASS" ? 0 : 1);

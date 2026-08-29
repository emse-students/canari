#!/usr/bin/env node
/**
 * THE NEW-DEVICE HEAL ROWS - one runner, one row per invocation.
 *
 *   node healnew.mjs --row 1     nothing else online
 *   node healnew.mjs --row 2     the PEER online from the start
 *   node healnew.mjs --row 3     our own W1 online from the start
 *   node healnew.mjs --row 11    our own W1 arriving LATE
 *   node healnew.mjs --row 12    the PEER arriving LATE
 *   node healnew.mjs --row 15    usability while the sidebar is amber
 *
 * ONE FILE, BECAUSE THE ROWS DIFFER IN EXACTLY TWO THINGS: which responder may be online, and
 * WHEN it comes online. Everything else - mint a device the server has never seen, watch the
 * sidebar until it settles or does not, gate on what the console said - is identical, and six
 * copies of it would be six places for the assertion to drift. The differences are data, in
 * `ROWS` below, which is also what makes the ORDER pairs comparable at all: rows 3 and 11 run the
 * same code with `respondersAt` moved, so a difference between them is the app's, never the rig's.
 *
 * WHAT "PASS" MEANS HERE, and it is not "the sidebar went green". Two of these rows are expected
 * NOT to heal - a fresh device alone with no GroupInfo published cannot get in, and no amount of
 * waiting changes that - so a row asserts the OUTCOME ITS CONDITION ENTAILS, and a heal where none
 * was possible is as much a failure as a stall where one was. `expect` names it per row.
 *
 * THE TIMELINE IS EVIDENCE, NOT DECORATION (user, 2026-08-27: does everything eventually heal, and
 * does the time hurt navigation). Every sample carries an elapsed offset and a wall-clock stamp, so
 * a stall can be lined up against a console line, a server log or a logcat line. Assertions use the
 * offsets; nothing here asserts on a wall clock.
 *
 * THE ORDER PAIRS ARE AN EQUALITY (user, same day): a responder already online when the fresh device
 * enumerates, and the same responder arriving after every row has gone amber, must reach the SAME
 * final state. So each row records `finalState` - a fingerprint of readiness, not a screenshot - and
 * `compare.mjs`-style adjudication is a plain read of two ledger lines. A difference in final state
 * is a FAIL for the pair; a difference in TIME is dirt carrying a number.
 *
 * WHAT IT REFUSES TO GUESS. "Nothing else online" is a claim about the whole FLEET, not about the
 * three clients this rig drives: the preflight has already caught an online owner device the rig
 * does not control. A row whose condition cannot be established is recorded as `INVALID` with the
 * intruder named - never quietly measured as though the condition held, because that is the one
 * failure mode that produces a confident wrong answer.
 */
import { spawnSync } from "node:child_process";
import { client, ensureChat } from "./chat.mjs";
import { installTag } from "./devices.mjs";
import { isUp, killBrowser, startBrowser } from "./launch.mjs";
import { ORIGIN, PORTS, SITE } from "./names.mjs";
import { becomeANewDevice } from "./newdevice.mjs";
import { forceStop, launch, pid, sh } from "./phone.mjs";
import { onlineDevicesOf } from "./presence.mjs";
import { bringToReady } from "./ready-repair.mjs";
import { finishObserved, record, unmet } from "./results.mjs";
import { splitBySubset, subsetSettled } from "./servable.mjs";
import { activeGroupIds, cut, navigationCost, readAll, sidebar, whoAmI, watch as watchRows } from "./syncrows.mjs";
import { report } from "./watch.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/**
 * A RESPONDER CAN ONLY SERVE A GROUP IT IS A MEMBER OF, AND THAT MAKES TWO OF THESE ROWS
 * UNSATISFIABLE ON THIS ACCOUNT - measured 2026-08-28, so it is not re-derived from a FAIL.
 * `dm_device_group_memberships` says the owner holds ELEVEN active groups while the peer that shares
 * the most shares TWO, and every other user of the account's world shares exactly one. So rows 2 and
 * 12, whose responder is the PEER, name a device that can answer for at most 2 of the 11 - and
 * `everyRowHealed` over all of them cannot be reached however correct the code is. HEAL-NEW-2's
 * re-run on 2026-08-28 landed exactly there: every rig premise met (the phone stopped, the abandoned
 * id purged, the fleet drained in 982 ms), 100 `welcome_request`s at the documented 60 s cadence,
 * two `externalJoin succeeded`, ONE group ready and nine still amber after 600 s. **That is a
 * statement about who was online, not about the mechanism** - rows 3, 11 and 15 name W1, another
 * device of the OWNER and therefore a member of all eleven, and they are satisfiable unchanged.
 *
 * SO THEY ASSERT THE SERVABLE SUBSET, AND THAT IS THE SAME CLAIM NARROWED, NOT A WEAKER ONE. Rows 2
 * and 12 carry `expect: 'servableSubset'`: the responder's own client is asked which groups it is
 * actually a member of, the fresh device's rows are intersected with that list, and every row in the
 * intersection must heal. The rows outside it are recorded and not asserted - a group no online
 * device is a member of has no path to this device at all, and demanding one is how a rig blames the
 * product for the shape of an account. An EMPTY intersection is `INVALID`, never a pass: a predicate
 * over an empty set is vacuously true, which would make the one row that cannot be run the fastest
 * PASS on the board. The same reasoning as row 1's `expect: 'either'` - where the answer is a fact
 * about the account, the row's job is the SEPARATION, and here the separation is measured by id.
 *
 * THE ROWS, AS DATA.
 *
 * `responder` is WHO may answer a fresh device's request for re-admission; `at` is WHEN they are
 * allowed to. `expect` is the outcome the condition entails - and `'either'` is not a shrug, it is
 * the honest answer for a row whose population is unknown until it runs: whether any group has a
 * published GroupInfo decides whether an isolated device can get in by itself, and that is a fact
 * about the account, not about the code. Where `expect` is `'either'` the row's assertion is the
 * SEPARATION - the timeline must say which happened and why - never the outcome.
 */
const ROWS = {
  1: {
    id: "HEAL-NEW-1",
    responder: null,
    at: null,
    what: "fresh device, nothing else online",
    expect: "either",
  },
  2: {
    id: "HEAL-NEW-2",
    responder: "w2",
    at: "start",
    what: "fresh device, the PEER online from the start",
    expect: "servableSubset",
  },
  3: {
    id: "HEAL-NEW-3",
    responder: "w1",
    at: "start",
    what: "fresh device, our own W1 online from the start",
    expect: "healed",
  },
  11: {
    id: "HEAL-NEW-11",
    responder: "w1",
    at: "late",
    what: "fresh device alone, then our own W1 arrives",
    expect: "healed",
  },
  12: {
    id: "HEAL-NEW-12",
    responder: "w2",
    at: "late",
    what: "fresh device alone, then the PEER arrives",
    expect: "servableSubset",
  },
  15: {
    id: "HEAL-NEW-15",
    responder: "w1",
    at: "start",
    what: "is the app usable while the sidebar is amber",
    expect: "either",
    usability: true,
  },
};

const row = ROWS[opt("row", "")];
if (!row) {
  console.error(`healnew: --row must be one of ${Object.keys(ROWS).join(", ")}`);
  process.exit(2);
}

/** How long a row may wait for the sidebar to settle before the stall IS the measurement. */
const SETTLE_MS = Number(opt("settle", "600")) * 1000;
/** How long to let the fresh device sit amber alone before a `late` responder is started. */
const ALONE_MS = Number(opt("alone", "90")) * 1000;

const T0 = Date.now();
const stage = (s) =>
  console.log(`[healnew:${row.id}] +${((Date.now() - T0) / 1000).toFixed(1)}s ${s}`);

/** A wall stamp beside every offset, because a stall is diagnosed against logs on other machines. */
const mark = (what) => ({ what, at: Date.now() - T0, wall: new Date().toISOString() });

/** An error's first line only: a stack in a ledger detail is noise nobody reads. */
const firstLine = (e) =>
  String(e?.message ?? e)
    .split(/\r?\n/)[0]
    .slice(0, 200);

const timeline = [mark("start")];
const note = (what) => {
  const m = mark(what);
  timeline.push(m);
  stage(what);
  return m;
};

/**
 * Puts the two peer browsers where this row needs them, and says what it actually did.
 *
 * A responder that must be ABSENT is killed rather than navigated away: a backgrounded tab is still
 * a connected gateway client and would answer a `welcome_request` exactly as a foreground one does,
 * so "not online" has to mean the process is gone. A responder that must be present is started and
 * left on `/chat`, because a client parked elsewhere is online and is not listening to this group.
 */
/**
 * Takes the PHONE out of the picture, because it is an own-account responder nobody here controls.
 *
 * A1 IS NOT PART OF ANY HEAL-NEW TOPOLOGY, AND LEAVING IT ONLINE BREAKS EVERY ROW rather than only
 * the isolated one. Row 1 claims nothing of the account was online. Rows 2 and 12 claim NO device of
 * ours could have served the Welcome, which is the whole reason the peer is provably the responder.
 * Rows 3, 11 and 15 name W1 as the responder and could not say whether W1 or the phone answered. In
 * all five the phone is a second listener of the same person, fanned into every group the owner
 * creates - the same class of confounder that already cost one rung its attribution.
 *
 * `am force-stop` IS THE RIGHT KILL, for the reason `setTopology` kills a browser instead of
 * navigating it: a backgrounded app keeps its gateway socket and answers a `welcome_request` exactly
 * as a foreground one does, so the process has to be gone. The cost is documented in `phone.mjs` - a
 * force-stopped package sits in Android's STOPPED state where FCM broadcasts are cancelled until
 * something launches it explicitly - which is why this is paired with a restore, and why no row here
 * measures a push.
 *
 * AN ABSENT PHONE IS NOT A FALLBACK. A phone that is not plugged in cannot be a responder, so there
 * is nothing to do and no row is weakened; what WOULD weaken one is assuming that instead of reading
 * it. So the three outcomes are reported apart - stopped by us, already down, or out of reach - and
 * `pid()` alone cannot tell the last two apart, since it swallows an adb failure into the same null.
 */
function takeThePhoneOffline() {
  try {
    sh("echo ok");
  } catch (e) {
    return { phone: "out of reach", why: firstLine(e) };
  }
  const before = pid();
  if (!before) return { phone: "already down" };
  try {
    forceStop();
  } catch (e) {
    return { phone: "refused the stop", pidWas: before, why: firstLine(e) };
  }
  for (let i = 0; i < 10; i += 1) {
    if (!pid()) return { phone: "stopped", pidWas: before, waitedMs: i * 500 };
    spawnSync(process.execPath, ["-e", "setTimeout(function () {}, 500)"]);
  }
  return { phone: "still running after the stop", pidWas: before };
}

/**
 * Puts the phone back, on EVERY exit path, because a row must not leave the rig worse than it found.
 *
 * REGISTERED AS AN EXIT HOOK rather than called at the end. This file records and exits from a dozen
 * places - an unmet expectation, an unreadable fleet, an intruder that voids the row - and a restore
 * written at the bottom would be reached by none of them. A force-stopped package receives no FCM
 * broadcast until something starts it, so a row that died early would silently cost every later push
 * row its subject, and the failure would surface hours away from its cause.
 *
 * SYNCHRONOUS, because an exit hook cannot await: `phone.mjs`'s `sh` is a synchronous spawn, so the
 * launch really does happen before the process leaves. It restores the APP, not the devtools forward
 * - `phone.mjs <port>` owns that - so the next `+A1` row still arms the phone as it always did.
 */
function giveThePhoneBackOnExit(taken) {
  if (taken.phone !== "stopped") return;
  process.on("exit", () => {
    try {
      launch();
      console.log(`[healnew:${row.id}] the phone was restarted (it was stopped for this row)`);
    } catch (e) {
      console.log(`[healnew:${row.id}] COULD NOT RESTART THE PHONE: ${firstLine(e)} - arm it before a push row`);
    }
  });
}

/**
 * Brings the two browser clients to the presence this row wants - and a WANTED one all the way to a
 * named starting point, not merely to a running process.
 *
 * A RUNNING BROWSER IS NOT A RESPONDER, AND THIS COST HEAL-NEW-3 A WHOLE PASS on 2026-08-28. W1 was
 * alive and signed OUT, sitting on /login. `startBrowser` no-ops on a browser that is already up and
 * the private `unlock()` this replaces called `pin.mjs`, which answers a gate a logged-out client
 * never mounts - so the row proceeded with no responder at all, watched ten groups stay amber for
 * ten minutes and recorded a product FAIL about the rig's own omission.
 *
 * `bringToReady` IS THE PREFLIGHT'S OWN REPAIR, IMPORTED. It is the fourth caller of a predicate
 * that used to live only inside `run.mjs`, and the four states it repairs are exactly the four a
 * responder can be found in: no session (sign it back in), the PIN gate (unlock), a page where the
 * gate does not mount (send it to /chat), and still booting (wait). The reason the unlock mattered
 * survives unchanged: a client on the gate holds a session and answers nothing, because it has no
 * MLS state loaded and cannot build a Welcome - reading a stall on a locked responder blames the app
 * for the rig's omission.
 *
 * WHAT IT DID DOES NOT DECIDE ANYTHING HERE. The trail is returned so the row can record it, and the
 * caller refuses the row; a topology helper that exited would take the phone-restore hook with it.
 */
async function setTopology(present) {
  const acted = {};
  for (const which of ["w1", "w2"]) {
    const wanted = present.includes(which);
    const up = await isUp(which);
    if (!wanted) {
      acted[which] = up ? `killed in ${await killBrowser(which)}ms` : "already down";
      continue;
    }
    if (!up) {
      await startBrowser(which, `${SITE}/chat`);
      acted[which] = "started";
    } else {
      acted[which] = "already up";
    }
    const r = await bringToReady(which.toUpperCase(), { log: (line) => note(`ready ${line.trim()}`) });
    if (r.unreachable) acted[which] += `, UNREACHABLE: ${r.unreachable}`;
    else acted[which] += `, ${r.ok ? "ready" : "NOT READY"} (${r.trail.join(" -> ")})`;
    acted[`${which}Ready`] = r.ok === true;
  }
  return acted;
}

/**
 * Every device of this account talking to the gateway right now, minus the fresh one this row minted.
 *
 * WHY THE GATEWAY AND NOT THE RIG. "Nothing else online" is a claim about the FLEET, and the rig
 * knows only about the three clients it drives. `presence.mjs` reads the `user:online:` keys, so it
 * can see a device the rig has never heard of - a browser on another machine, a phone left running -
 * and one of those has already turned a row dirty once. A read it cannot perform is reported as
 * unreadable, never as an empty fleet: a failed read is not an absence.
 *
 * A DEAD DEVICE'S KEY OUTLIVES IT BY UP TO 20 SECONDS. The key is deleted by the connection's `Drop`
 * guard and expires on a 20 s TTL otherwise, so the device W3 was BEFORE the wipe can still be
 * listed for a moment after the reload. That ghost drains and a real device does not, which is what
 * makes waiting for it a proof rather than a sleep: re-read until the extras are gone, and report
 * whatever is still there at the deadline as genuinely present.
 */
function fleetNow(userId, mineFull) {
  try {
    return { readable: true, extra: onlineDevicesOf(userId).filter((d) => d !== mineFull) };
  } catch (e) {
    return { readable: false, why: firstLine(e) };
  }
}

async function fleetBesides(userId, mineFull, { drainMs = 30_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const now = fleetNow(userId, mineFull);
    if (!now.readable) return now;
    if (now.extra.length === 0) return { readable: true, extra: [], drainedInMs: Date.now() - t0 };
    if (Date.now() - t0 >= drainMs)
      return { readable: true, extra: now.extra.map(installTag), waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * THE SAME READ WITH THE OPPOSITE POLARITY: waits until another device of this account IS there.
 *
 * "Prove nobody else is online" and "wait for our responder to arrive" are two questions, and
 * `fleetBesides` only answers the first: it returns the INSTANT the fleet reads empty, because an
 * empty fleet is the answer it was written for. Asked of the arrival case it answers 961 ms after a
 * responder failed to exist - which is exactly what HEAL-NEW-3 did on 2026-08-28, then watched ten
 * groups stay amber for ten minutes and recorded a product FAIL. A COLUMN IS ONLY EVIDENCE FOR THE
 * QUESTION IT WAS WRITTEN TO ANSWER.
 *
 * The deadline is generous because it covers a full sign-in: `bringToReady` may have just spent a
 * whole OIDC round trip, and the gateway key is written when the socket opens, not when the page
 * loads. Returning an empty fleet at the deadline is a REPORT, not a verdict - the caller refuses
 * the row as INVALID, because a precondition the rig could not establish is not a product fact.
 */
async function awaitFleetMember(userId, mineFull, { waitMs = 90_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const now = fleetNow(userId, mineFull);
    if (!now.readable) return now;
    if (now.extra.length > 0)
      return { readable: true, extra: now.extra.map(installTag), arrivedInMs: Date.now() - t0 };
    if (Date.now() - t0 >= waitMs) return { readable: true, extra: [], waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------------------------

const startPresent = row.responder && row.at === "start" ? [row.responder] : [];
note(`topology for "${row.what}" - present at start: ${startPresent.join(",") || "none"}`);

// THE PHONE FIRST, AND FOR EVERY ROW. It is not one of the two responders a row chooses between, so
// it is not in `startPresent` and never will be: it is a third device of the OWNER's account that no
// row here models, and it has to be gone before the fresh device is minted rather than after, or it
// can answer the very first discovery the row is trying to attribute.
const phone = takeThePhoneOffline();
giveThePhoneBackOnExit(phone);
note(`phone ${JSON.stringify(phone)}`);

const topology = await setTopology(startPresent);
note(`topology ${JSON.stringify(topology)}`);

// THE PRIMITIVE, MEASURED BY HEAL-NEW-0 AND REUSED HERE. `--keep-open` is why it is a module: the
// device it mints is the device this row then watches, and re-minting per row would pay the whole
// enrolment again for nothing.
note("minting a device the server has never seen");
const minted = await becomeANewDevice({ report: (s) => note(`newdevice: ${s}`) });
note(
  `minted ${JSON.stringify({
    freshId: minted.aFreshIdWasMinted,
    neverSeen: minted.theServerHadNeverSeenIt,
    sameAccount: minted.theSameAccountCameBack,
    enrolled: minted.enrolled,
    // HOW LONG the key package took. It is in the note because it is the number that told HEAL-NEW-2
    // its FAIL was the instrument's: the sidebar had healed all ten rows while the census still said no.
    enrolledInMs: minted.enrolledInMs,
    pinGate: minted.pinGate,
    pinOk: minted.pinOk,
  })}`,
);
const cx = minted.cx;
// The primitive's OWN observer, not a second one: it was installed before the wipe, so it holds the
// console of the whole heal, and two watchers on one connection would drain each other's events.
const w3 = minted.observer;
await ensureChat(cx);

const first = await readAll(cx);
note(`first read ${JSON.stringify(first)}`);

// WHO ELSE IS HOLDING THIS ACCOUNT OPEN, asked at the moment the fresh device starts enumerating -
// which is the only moment the answer bears on the row. It is read for EVERY row because it is the
// evidence that says which responder the heal could have come from, and it REFUSES only the isolated
// row, whose whole condition is that there was none.
const me = await whoAmI(cx);
// AND ASKED WITH THE POLARITY THIS ROW NEEDS. A row whose responder is our own W1, present from
// the start, has "another device of this account is online" as its PREMISE - so an empty read is the
// thing to wait for, not the answer to record.
const wantsOwnResponderNow = row.responder === "w1" && row.at === "start";
const fleet = wantsOwnResponderNow
  ? await awaitFleetMember(me.userId, me.deviceId)
  : await fleetBesides(me.userId, me.deviceId);
note(`fleet ${JSON.stringify(fleet)}`);
if (wantsOwnResponderNow && fleet.readable && fleet.extra.length === 0) {
  record(row.id, "INVALID", {
    unobservable: `the row needs our own ${row.responder.toUpperCase()} online as the responder and the gateway never listed it within ${Math.round((fleet.waitedMs ?? 0) / 1000)}s - topology said ${JSON.stringify(topology)}`,
    what: row.what,
    topology,
    timeline,
  });
  cx.close();
  process.exit(1);
}
if (row.responder === null && fleet.readable && fleet.extra.length > 0) {
  record(row.id, "INVALID", {
    unobservable: `the row needs an isolated account and ${fleet.extra.length} other device(s) of it are online: ${fleet.extra.join(",")}`,
    what: row.what,
    timeline,
  });
  cx.close();
  process.exit(1);
}
if (row.responder === null && !fleet.readable) {
  record(row.id, "INVALID", {
    unobservable: `the row needs an isolated account and the gateway could not be asked: ${fleet.why}`,
    what: row.what,
    timeline,
  });
  cx.close();
  process.exit(1);
}

/** The device went amber before anything could answer - the precondition of every `late` row. */
let wentAmber = null;
/** The fleet as it stood once a `late` own-account responder had actually connected. */
let lateFleet = null;
if (row.at === "late") {
  const deadline = Date.now() + ALONE_MS;
  for (;;) {
    const s = await sidebar(cx);
    if (s.panel && s.rows > 0 && s.syncing > 0) {
      wentAmber = note(`amber alone: ${JSON.stringify(s)}`);
      break;
    }
    if (Date.now() >= deadline) {
      wentAmber = note(`never went amber alone within ${ALONE_MS / 1000}s: ${JSON.stringify(s)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  note(`starting the late responder ${row.responder}`);
  const late = await setTopology([row.responder]);
  note(`topology ${JSON.stringify(late)}`);
  // For an own-account responder, "it arrived" is a fleet fact and is read as one. Started is not
  // connected: a browser that launched and never reached the gateway would leave the row measuring
  // the isolated case under the late case's name.
  if (row.responder === "w1") {
    lateFleet = await awaitFleetMember(me.userId, me.deviceId);
    note(`late fleet ${JSON.stringify(lateFleet)}`);
  }
}

const respondersReadyAt = mark("responders in place");
timeline.push(respondersReadyAt);

// ---------------------------------------------------------------------------------------------
// WHAT THE RESPONDER CAN ACTUALLY SERVE, ASKED OF THE RESPONDER, BEFORE ANYTHING IS WAITED ON.
//
// A RESPONDER CAN ONLY ANSWER FOR A GROUP IT IS A MEMBER OF. For an own-account responder that is
// every group, so "the sidebar went quiet" is the right proof and these rows never needed this. For
// a PEER it is a subset - measured 2026-08-28, eleven groups on the owner against two on the peer
// that shares the most - and `everyRowHealed` is then unreachable however correct the app is. The
// row that asserted it recorded a product FAIL for a fact about who was online.
//
// SO THE ROW'S CLAIM IS SCOPED TO THE SUBSET AND THE SUBSET IS MEASURED, NEVER ASSUMED. It is read
// from the responder's own client, at the moment the responder is in place, because it is exactly
// then that it is true: a `late` row has just started the peer, and a membership read taken before
// that would describe a browser that was not running.
//
// AN EMPTY SUBSET IS UNOBSERVABLE, NOT A PASS. If the peer shares nothing with the fresh device
// there is no heal anybody could have served, and a predicate over an empty set is vacuously true -
// which would turn the one row that cannot be run into the fastest PASS on the board.
// ---------------------------------------------------------------------------------------------
/** The full ids the responder is a member of, and the fresh device's rows that intersect them. */
let servable = null;
if (row.expect === "servableSubset") {
  const which = row.responder.toUpperCase();
  // `client` IS ASYNC, and an unawaited one is a Promise that reaches `whoAmI` as `cx.send is not a
  // function` - the row would ERROR at the exact moment it measures rather than record anything.
  const rcx = await client(PORTS[which], new URL(ORIGIN[which]).hostname);
  const rwho = await whoAmI(rcx);
  const groups = await activeGroupIds(rcx, rwho.userId ?? "");
  rcx.close();
  const before = await sidebar(cx);
  const ids = new Set(groups.ids ?? []);
  // ONE DEFINITION OF THE SUBSET, shared with the termination proof below and with its self-test.
  // Splitting here and re-filtering there is how the two would drift apart, and only one of them
  // decides the verdict.
  const { inTheSubset, outside } = splitBySubset(before.tiles, ids);
  servable = {
    responder: which,
    responderGroups: groups.ids?.length ?? null,
    unreadable: groups.why,
    ids,
    rowsInTheSubset: inTheSubset.map((t) => cut(t.id)),
    rowsOutside: outside.map((t) => cut(t.id)),
  };
  note(
    `servable ${JSON.stringify({
      responder: which,
      responderGroups: servable.responderGroups,
      unreadable: servable.unreadable,
      inTheSubset: servable.rowsInTheSubset.length,
      outside: servable.rowsOutside.length,
    })}`,
  );
  if (groups.ids === null) {
    record(row.id, "INVALID", {
      unobservable: `the row asserts what ${which} can serve and its membership could not be read: ${groups.why}`,
      what: row.what,
      topology,
      timeline,
    });
    cx.close();
    process.exit(1);
  }
  if (inTheSubset.length === 0) {
    record(row.id, "INVALID", {
      unobservable: `${which} shares no group with this device's ${before.rows ?? 0} row(s), so no heal here could have been served by the responder the row names`,
      what: row.what,
      servable: { responderGroups: servable.responderGroups, rowsOutside: servable.rowsOutside },
      topology,
      timeline,
    });
    cx.close();
    process.exit(1);
  }
}

note(`watching the sidebar for up to ${SETTLE_MS / 1000}s`);
// TERMINATION IS A PROOF, AND FOR A SUBSET ROW IT IS A DIFFERENT PROOF - the rows the responder
// cannot serve are allowed to stay amber, so waiting for the whole sidebar would burn the deadline
// every time and report a stall nobody could have avoided.
const w = await watchRows(cx, {
  timeoutMs: SETTLE_MS,
  log: (m) => console.log(m),
  ...(servable ? { settledWhen: subsetSettled(servable.ids) } : {}),
});
timeline.push(mark(w.settled ? "settled" : "deadline reached"));

const usability = row.usability ? await navigationCost(cx) : null;
if (usability) note(`usability ${JSON.stringify(usability)}`);

const last = await readAll(cx);
note(`last read ${JSON.stringify(last)}`);

/**
 * The fingerprint two ORDERS are compared on.
 *
 * Counts and the server's own view, never a list of names: the pair assertion is "the same final
 * state", and a name would put a real person's conversation in a public ledger to answer a question
 * counts already answer.
 */
const finalState = {
  rows: last.rows.rows,
  ready: last.rows.ready,
  syncing: last.rows.syncing,
  removed: last.rows.removed,
  serverActive: last.server.active ?? null,
};

const healed = w.settled === true;
const expectations = {
  /** The device really was new - the primitive's own claim, re-asserted where it is depended on. */
  freshDevice: minted.aFreshIdWasMinted === true,
  serverHadNeverSeenIt: minted.theServerHadNeverSeenIt === true,
  /** It came back as the SAME person and finished enrolling, or the row measures a stranger. */
  sameAccountEnrolled: minted.theSameAccountCameBack === true && minted.enrolled === true,
  /** The sidebar was actually populated: a settled EMPTY list is not a heal, it is a blank page. */
  rowsWereEnumerated: last.rows.rows > 0,
  /** The reader still matches the markup. `unhooked > 0` means the count means nothing. */
  readerMatchesMarkup: last.rows.unhooked === 0,
  /** Every sample carries both clocks, which is what makes the stall diagnosable off-machine. */
  timelineIsStamped: timeline.every((m) => typeof m.at === "number" && typeof m.wall === "string"),
};
if (row.expect === "healed") expectations.everyRowHealed = healed;
// THE SUBSET ROW'S CLAIM, AND IT IS THE SAME CLAIM NARROWED, NOT A WEAKER ONE: every group the
// responder could have answered for did heal. The rows outside the subset are REPORTED and not
// asserted - a group nobody online is a member of has no path to this device, and demanding one is
// how a rig blames the product for the shape of the account.
if (row.expect === "servableSubset") expectations.everyServableRowHealed = healed;
// The responder the row NAMES must be the one that could have answered. For an own-account
// responder that is a fleet fact; for the peer, the fleet must hold NOTHING of ours, or a second
// device of the owner could have served the Welcome and the row would be measuring the wrong path.
if (row.responder === "w1" && row.at === "start")
  expectations.ourOwnDeviceWasInTheFleet = fleet.readable === true && fleet.extra.length > 0;
if (row.responder === "w2")
  expectations.noOwnDeviceCouldHaveAnswered = fleet.readable === true && fleet.extra.length === 0;
if (row.at === "late")
  expectations.wentAmberBeforeTheResponderArrived = (wentAmber?.what ?? "").startsWith(
    "amber alone",
  );
if (row.responder === "w1" && row.at === "late")
  expectations.ourOwnDeviceArrivedLate = lateFleet?.readable === true && lateFleet.extra.length > 0;
if (row.usability) expectations.navigableWhileAmber = usability?.openedInMs != null;

const missing = unmet(expectations);
const verdict = missing.length === 0 ? "PASS" : "FAIL";

// THE REPORT IS TAKEN ONCE AND HANDED TO BOTH READERS. `recordObserved` accepts a finished report
// as readily as a live handle, and reporting twice on one observer drains the second read.
const w3Report = await report(w3);
const detail = {
  what: row.what,
  expect: row.expect,
  responder: row.responder,
  responderAt: row.at,
  healed,
  // The subset as it was measured, minus the id Set, which is a working value and not a result.
  servable: servable
    ? {
        responder: servable.responder,
        responderGroups: servable.responderGroups,
        rowsInTheSubset: servable.rowsInTheSubset,
        rowsOutside: servable.rowsOutside,
        finalStateOfTheSubset: (w.final?.tiles ?? [])
          .filter((t) => servable.rowsInTheSubset.includes(t.id))
          .map((t) => ({ id: t.id, ready: t.ready })),
      }
    : null,
  settledInMs: w.settled ? w.elapsedMs : null,
  stalledForMs: w.settled ? null : w.elapsedMs,
  finalState,
  laggards: w.final ? w.final.syncing : null,
  usability,
  fleet,
  lateFleet,
  topology,
  samples: w.samples,
  timeline,
  unmet: missing,
  observers: { w3: w3Report },
};

// THE ASSERTION IS NOT THE VERDICT, AND THIS RUNNER WAS THE LAST PLACE THAT BELIEVED IT WAS.
//
// Forty-eight checks put their outcome through `gate()` and these six HEAL runners did not - so a
// HEAL row could hold a console full of severe lines, or be measured across a deploy that replaced
// the server mid-run, and still print `PASS`. HEAL-NEW-11 did exactly the first on 2026-08-28: every
// expectation met, `clean: false` recorded beside it as decoration, and a `PASS` on the board that
// no other rung's `PASS` meant the same thing as. A field in the detail is not a gate; only a gate
// is a gate.
//
// THE REDEPLOY HALF IS THE SHARPER ONE. A push to `main` redeploys the server this rig points at,
// and the campaign has already lost three cells to a run that straddled one. Every gated check turns
// VACUOUS there and says so; these six would have recorded a product verdict about a server that
// went away mid-measurement - a Work Package written about us.
cx.close();
await finishObserved(row.id, verdict, detail, { W3: w3Report });

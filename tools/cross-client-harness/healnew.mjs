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
import { ensureChat } from "./chat.mjs";
import { installTag } from "./devices.mjs";
import { isUp, killBrowser, startBrowser } from "./launch.mjs";
import { SITE } from "./names.mjs";
import { becomeANewDevice } from "./newdevice.mjs";
import { forceStop, launch, pid, sh } from "./phone.mjs";
import { onlineDevicesOf } from "./presence.mjs";
import { record, unmet } from "./results.mjs";
import { navigationCost, readAll, sidebar, whoAmI, watch as watchRows } from "./syncrows.mjs";
import { report } from "./watch.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/**
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
    expect: "healed",
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
    expect: "healed",
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

async function setTopology(present) {
  const acted = {};
  for (const which of ["w1", "w2"]) {
    const wanted = present.includes(which);
    const up = await isUp(which);
    if (wanted && !up) {
      await startBrowser(which, `${SITE}/chat`);
      acted[which] = "started";
    } else if (!wanted && up) {
      const ms = await killBrowser(which);
      acted[which] = `killed in ${ms}ms`;
    } else {
      acted[which] = up ? "already up" : "already down";
    }
  }
  return acted;
}

/**
 * Unlocks a responder so it is a real member and not a locked shell.
 *
 * A client sitting on the PIN gate holds a session and answers nothing: it has no MLS state loaded,
 * so it cannot build a Welcome. Reading a stall on a locked responder would blame the app for the
 * rig's omission, which is the class of fault that made a whole rung unattributable once already.
 */
function unlock(device) {
  const r = spawnSync(process.execPath, ["pin.mjs", "--device", device], {
    encoding: "utf8",
    cwd: import.meta.dirname,
  });
  return { status: r.status, tail: (r.stdout || r.stderr || "").trim().split("\n").slice(-1)[0] };
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
async function fleetBesides(userId, mineFull, { drainMs = 30_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let online;
    try {
      online = onlineDevicesOf(userId);
    } catch (e) {
      return { readable: false, why: firstLine(e) };
    }
    const extra = online.filter((d) => d !== mineFull);
    if (extra.length === 0) return { readable: true, extra: [], drainedInMs: Date.now() - t0 };
    if (Date.now() - t0 >= drainMs)
      return { readable: true, extra: extra.map(installTag), waitedMs: Date.now() - t0 };
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
for (const which of startPresent) {
  const u = unlock(which.toUpperCase());
  note(`unlock ${which.toUpperCase()} ${JSON.stringify(u)}`);
}

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
const fleet = await fleetBesides(me.userId, me.deviceId);
note(`fleet ${JSON.stringify(fleet)}`);
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
  const u = unlock(row.responder.toUpperCase());
  note(`unlock ${row.responder.toUpperCase()} ${JSON.stringify(u)}`);
  // For an own-account responder, "it arrived" is a fleet fact and is read as one. Started is not
  // connected: a browser that launched and never reached the gateway would leave the row measuring
  // the isolated case under the late case's name.
  if (row.responder === "w1") {
    lateFleet = await fleetBesides(me.userId, me.deviceId, { drainMs: 0 });
    for (let i = 0; i < 20 && lateFleet.readable && lateFleet.extra.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      lateFleet = await fleetBesides(me.userId, me.deviceId, { drainMs: 0 });
    }
    note(`late fleet ${JSON.stringify(lateFleet)}`);
  }
}

const respondersReadyAt = mark("responders in place");
timeline.push(respondersReadyAt);

note(`watching the sidebar for up to ${SETTLE_MS / 1000}s`);
const w = await watchRows(cx, { timeoutMs: SETTLE_MS, log: (m) => console.log(m) });
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

const reports = { w3: await report(w3) };
const detail = {
  what: row.what,
  expect: row.expect,
  responder: row.responder,
  responderAt: row.at,
  healed,
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
  clean: reports.w3.clean,
  observers: { w3: reports.w3 },
};

record(row.id, verdict, detail);
cx.close();
process.exit(verdict === "PASS" ? 0 : 1);

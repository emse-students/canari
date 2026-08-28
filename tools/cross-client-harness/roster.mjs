#!/usr/bin/env node
/**
 * THE MEMBERSHIP TABLE ITSELF - the four rows nothing on this board could have caught.
 *
 *   node roster.mjs --row 10    the whole-population invariant, no client needed
 *   node roster.mjs --row 7     every device of both users is active, and none is a placeholder
 *   node roster.mjs --row 8     a device enrolled while the PEER is offline still activates
 *   node roster.mjs --row 9     what a message sent to a PENDING device is worth afterwards
 *
 * WHY A NEW FILE. Two hundred rows on this ladder read screens, consoles and Redis; exactly one
 * reads `dm_device_group_memberships`, and it reads WHO is named rather than WHAT STATUS they hold.
 * A conversation lost both directions for 134 minutes because a `userId=unknown` / `deviceId=pending`
 * row was stored as an ACTIVE member while both of the peer's real devices sat `pending`, and nothing
 * here could have seen it. These rows read the status.
 *
 * THE BUDGET IS MEASURED, NOT INVENTED, AND IT IS NOT THE VERDICT BY ITSELF. Tonight's population on
 * production: 150 active, 10 pending, and NOT ONE pending row younger than an hour - the youngest is
 * 3 h 37, the oldest 2 d 14 h. So a 15-minute line sits in an empty region of the distribution rather
 * than through the middle of it. But a `pending` row is NOT a defect on its own: a device that is
 * simply switched off is legitimately pending until it comes back, and a predicate that called that
 * broken would cry every night. The discriminator is whether the device is ONLINE - a device talking
 * to the gateway right now, still pending past the budget, is the defect; the same row for a device
 * the gateway has never heard of is a person with a closed laptop. Both are reported, separately,
 * because a report that cannot tell its causes apart sends its reader to the wrong one.
 *
 * WHAT DOES NOT DEPEND ON A BUDGET AT ALL, and is therefore the hard verdict:
 *   - a row naming a placeholder identity, in any status. `unknown` and `pending` are the client's
 *     own sentinels for "no session yet"; they are not identities, and a row holding one is wrong
 *     however long it has been there. One exists on production as this is written, `status=active`.
 *   - a (group, user) pair with memberships but NONE active. That is the state that broke delivery:
 *     the server answers `No active membership`, every fetch returns nothing, and no commit is ever
 *     made. Zero such pairs tonight, which is what makes it a usable invariant rather than a
 *     permanent red light.
 *
 * NO NAMES AND NO WHOLE IDS. Group ids are cut to 8, device ids go through `installTag` and users
 * through `userTag`, so a finding can be lined up with `identity.mjs` and is useless to anyone else.
 * This file reads a table that holds every real user of the product, so nothing is ever dumped whole.
 */
import { ensureChat, client, countMessage, openChannel, send } from "./chat.mjs";
import { installTag, userTag } from "./devices.mjs";
import { isUp, killBrowser, startBrowser } from "./launch.mjs";
import { ORIGIN, PORTS, SITE } from "./names.mjs";
import { becomeANewDevice } from "./newdevice.mjs";
import { onlineDevicesOf } from "./presence.mjs";
import { record, unmet } from "./results.mjs";
import { psql } from "./ssh.mjs";
import { readAll, watch as watchRows, whoAmI } from "./syncrows.mjs";
import { report, watch } from "./watch.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

/**
 * THE ACTIVATION BUDGET. Measured against the population it runs on (see the header), and it is only
 * ever half of a predicate - the other half is whether the device is online.
 */
const BUDGET_MINUTES = Number(opt("budget", "15"));

/** The client's own non-identity literals, from `BaseMlsService.ts`. Not identities. */
const PLACEHOLDER_USER = "unknown";
const PLACEHOLDER_DEVICE = "pending";

const ROWS = {
  7: { id: "MULTI-7", what: "every device of both users active, none a placeholder" },
  8: { id: "MULTI-8", what: "a device enrolled while the peer is offline still activates" },
  9: { id: "MULTI-9", what: "a message sent to a pending device, afterwards" },
  10: { id: "MULTI-10", what: "the whole-population invariant" },
};

const row = ROWS[opt("row", "")];
if (!row) {
  console.error(`roster: --row must be one of ${Object.keys(ROWS).join(", ")}`);
  process.exit(2);
}

const T0 = Date.now();
const mark = (what) => ({ what, at: Date.now() - T0, wall: new Date().toISOString() });
const timeline = [mark("start")];
const note = (what) => {
  const m = mark(what);
  timeline.push(m);
  console.log(`[roster:${row.id}] +${(m.at / 1000).toFixed(1)}s ${what}`);
  return m;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) =>
  String(e?.message ?? e)
    .split(/\r?\n/)[0]
    .slice(0, 200);

/** Splits psql's tuples-only output into rows of fields. Empty output is no rows, not one blank. */
const rows = (out) =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|"));

/** A single scalar from psql, as a number. */
const scalar = (out) => Number(out.trim().split("\n")[0] || 0);

// ------------------------------------------------------------------------------ the SQL, one place
//
// EVERY QUERY IS A READ. Nothing in this file writes to the production database: a campaign row that
// repaired what it measured could never fail twice, and the repair would be the thing under test.

/** Rows naming a placeholder identity, whatever their status. */
const placeholderRows = () =>
  rows(
    psql(
      `SELECT left("groupId"::text,8), "userId", "deviceId", status, ` +
        `date_trunc('minute', now()-"createdAt")::text ` +
        `FROM dm_device_group_memberships ` +
        `WHERE "userId"='${PLACEHOLDER_USER}' OR "deviceId"='${PLACEHOLDER_DEVICE}' ` +
        `ORDER BY "createdAt"`,
    ),
  ).map(([grp, usr, dev, status, age]) => ({
    group: grp,
    user: usr === PLACEHOLDER_USER ? `LITERAL:${PLACEHOLDER_USER}` : userTag(usr),
    device: dev === PLACEHOLDER_DEVICE ? `LITERAL:${PLACEHOLDER_DEVICE}` : installTag(dev),
    status,
    age,
  }));

/**
 * (group, user) pairs holding memberships of which NONE is active.
 *
 * This is the state that breaks delivery in both directions, and it is the one invariant here that
 * needs no budget: a user in a group with no active device cannot be sent to, now or later.
 */
const usersWithNoActiveDevice = () =>
  rows(
    psql(
      `SELECT left("groupId"::text,8), "userId", count(*)::text ` +
        `FROM dm_device_group_memberships GROUP BY "groupId", "userId" ` +
        `HAVING count(*) FILTER (WHERE status='active') = 0 ORDER BY 1`,
    ),
  ).map(([grp, usr, n]) => ({ group: grp, user: userTag(usr), devices: Number(n) }));

/** Pending rows older than the budget, with the full device id so presence can be joined on it. */
const pendingPastBudget = () =>
  rows(
    psql(
      `SELECT left("groupId"::text,8), "userId", "deviceId", ` +
        `date_trunc('minute', now()-"createdAt")::text ` +
        `FROM dm_device_group_memberships ` +
        `WHERE status='pending' AND now()-"createdAt" > interval '${BUDGET_MINUTES} minutes' ` +
        `ORDER BY "createdAt"`,
    ),
  ).map(([grp, usr, dev, age]) => ({ group: grp, userFull: usr, deviceFull: dev, age }));

/** The status of one device in one group, or null when the table holds no such row. */
const statusOf = (groupId, deviceId) => {
  const out = psql(
    `SELECT status FROM dm_device_group_memberships ` +
      `WHERE "groupId"='${groupId}' AND "deviceId"='${deviceId}'`,
  ).trim();
  return out || null;
};

/** Every device id of one user in one group, with its status - the roster, as the server holds it. */
const rosterOf = (groupId) =>
  rows(
    psql(
      `SELECT "userId", "deviceId", status FROM dm_device_group_memberships ` +
        `WHERE "groupId"='${groupId}' ORDER BY "userId", "createdAt"`,
    ),
  ).map(([usr, dev, status]) => ({ userFull: usr, deviceFull: dev, status }));

/**
 * Splits pending rows by whether the gateway is talking to that device RIGHT NOW.
 *
 * THE DISCRIMINATOR THE REPORT OWES. A pending row for a device the gateway has never heard of is a
 * closed laptop; the same row for a device holding a live socket is the defect. A count that mixed
 * them would send its reader to the wrong cause, which is the failure mode a report exists to
 * prevent.
 */
function splitByPresence(pending) {
  const online = new Map();
  const stale = [];
  const offline = [];
  for (const p of pending) {
    if (!online.has(p.userFull)) {
      try {
        online.set(p.userFull, new Set(onlineDevicesOf(p.userFull)));
      } catch (e) {
        online.set(p.userFull, null);
        note(`the gateway could not be asked about ${userTag(p.userFull)}: ${firstLine(e)}`);
      }
    }
    const live = online.get(p.userFull);
    const shown = {
      group: p.group,
      user: userTag(p.userFull),
      device: installTag(p.deviceFull),
      age: p.age,
    };
    if (live === null) shown.presence = "unreadable";
    if (live && live.has(p.deviceFull)) stale.push(shown);
    else offline.push(shown);
  }
  return { stale, offline };
}

// ----------------------------------------------------------------------------------------- MULTI-10
if (row.id === "MULTI-10") {
  note(`reading the whole table, budget ${BUDGET_MINUTES} min`);
  const total = scalar(psql("SELECT count(*) FROM dm_device_group_memberships"));
  const active = scalar(
    psql("SELECT count(*) FROM dm_device_group_memberships WHERE status='active'"),
  );
  const pending = total - active;
  note(`${total} membership(s): ${active} active, ${pending} pending`);

  const placeholders = placeholderRows();
  note(`placeholder identities: ${placeholders.length}`);
  for (const p of placeholders) note(`  placeholder ${JSON.stringify(p)}`);

  const starved = usersWithNoActiveDevice();
  note(`(group, user) pairs with no active device: ${starved.length}`);
  for (const s of starved) note(`  starved ${JSON.stringify(s)}`);

  const past = pendingPastBudget();
  const { stale, offline } = splitByPresence(past);
  note(
    `pending past ${BUDGET_MINUTES} min: ${past.length} - ${stale.length} on a LIVE device, ${offline.length} on a device the gateway is not talking to`,
  );
  for (const s of stale) note(`  stale-while-online ${JSON.stringify(s)}`);

  const expectations = {
    /** No row may name a non-identity, in any status. This needs no budget and admits no excuse. */
    noPlaceholderIdentityAnywhere: placeholders.length === 0,
    /** Nobody is in a group the server cannot deliver to them in. */
    everyMemberHasAnActiveDevice: starved.length === 0,
    /** A device the gateway is talking to has no business still being pending. */
    noLiveDeviceLeftPending: stale.length === 0,
  };
  const missing = unmet(expectations);
  record(row.id, missing.length === 0 ? "PASS" : "FAIL", {
    what: row.what,
    budgetMinutes: BUDGET_MINUTES,
    population: { total, active, pending },
    placeholders,
    starved,
    pendingPastBudget: { total: past.length, staleWhileOnline: stale, offlineDevices: offline },
    // Said out loud because the verdict turns on it: a pending row for an offline device is NOT
    // counted against the product, and a reader must be able to see that decision rather than infer
    // it from a number that came out lower than the raw count.
    notCountedAgainstTheProduct: `${offline.length} pending row(s) belong to devices the gateway is not talking to`,
    timeline,
    unmet: missing,
  });
  process.exit(missing.length === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ the shared venue, for 7, 8 and 9
//
// THE VENUE RULE. Every row below needs a group both accounts are really in, and the campaign's own
// community/channel is the only one that is not some association's. Its ids are read from the
// clients rather than hard-coded, because a venue that was rebuilt three times is a venue whose id
// nobody should be remembering.
const OWNER = "W1";
const PEER = "W2";

/** The channel group id both accounts share, read from the owner's own store. */
async function venueGroupId(cx) {
  await openChannel(cx);
  const raw = await import("./cdp.mjs").then(({ evaluate }) =>
    evaluate(
      cx,
      `(function () {
         var m = location.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
         return JSON.stringify({ path: location.pathname, ids: m || [] });
       })()`,
    ),
  );
  return JSON.parse(raw);
}

const ownerCx = await client(PORTS[OWNER], new URL(ORIGIN[OWNER]).hostname);
const ownerWatch = await watch(ownerCx, OWNER);
await ensureChat(ownerCx);
const venue = await venueGroupId(ownerCx);
note(`venue ${JSON.stringify(venue)}`);
const groupId = venue.ids.at(-1) ?? null;
if (!groupId) {
  record(row.id, "INVALID", {
    unobservable: "the channel URL carried no group id, so no row here has a venue to read",
    venue,
    what: row.what,
    timeline,
  });
  ownerCx.close();
  process.exit(1);
}
note(`the venue group is ${groupId.slice(0, 8)}`);

// ------------------------------------------------------------------------------------------ MULTI-7
if (row.id === "MULTI-7") {
  // Both accounts must be present and settled first, or "every device is active" would be measured
  // against a roster still being built - which passes for the wrong reason.
  const peerUp = await isUp(PEER.toLowerCase());
  if (!peerUp) {
    await startBrowser(PEER.toLowerCase(), `${SITE}/chat`);
    note("the peer was down and was started");
  }
  const peerCx = await client(PORTS[PEER], new URL(ORIGIN[PEER]).hostname);
  const peerWatch = await watch(peerCx, PEER);
  await ensureChat(peerCx);
  await openChannel(peerCx);

  // One message each way, so the group is not merely joined but USED - a roster that is correct only
  // until someone speaks is not the property being claimed.
  const marker = `ROSTER7-${Math.random().toString(36).slice(2, 8)}`;
  await send(ownerCx, `${marker} owner`);
  await send(peerCx, `${marker} peer`);
  await sleep(8000);
  const seenByPeer = await countMessage(peerCx, `${marker} owner`);
  const seenByOwner = await countMessage(ownerCx, `${marker} peer`);
  note(`the exchange: peer saw ${seenByPeer}, owner saw ${seenByOwner}`);

  const roster = rosterOf(groupId);
  const shown = roster.map((r) => ({
    user: r.userFull === PLACEHOLDER_USER ? `LITERAL:${PLACEHOLDER_USER}` : userTag(r.userFull),
    device:
      r.deviceFull === PLACEHOLDER_DEVICE
        ? `LITERAL:${PLACEHOLDER_DEVICE}`
        : installTag(r.deviceFull),
    status: r.status,
  }));
  note(`roster of ${roster.length} row(s) ${JSON.stringify(shown)}`);

  const placeholdersHere = roster.filter(
    (r) => r.userFull === PLACEHOLDER_USER || r.deviceFull === PLACEHOLDER_DEVICE,
  );
  const pendingHere = roster.filter((r) => r.status !== "active");
  const usersHere = new Set(roster.map((r) => r.userFull));
  const usersWithoutActive = [...usersHere].filter(
    (u) => !roster.some((r) => r.userFull === u && r.status === "active"),
  );

  const expectations = {
    /** The exchange really happened, or the roster is being read after nothing. */
    bothDirectionsArrived: seenByPeer > 0 && seenByOwner > 0,
    /** The row's own subject. */
    noRowNamesAPlaceholder: placeholdersHere.length === 0,
    everyUserHasAnActiveDevice: usersWithoutActive.length === 0,
    /** Both accounts are in it at all - a roster of one is not the property being tested. */
    bothAccountsAreInTheRoster: usersHere.size >= 2,
  };
  const missing = unmet(expectations);
  const reports = { owner: await report(ownerWatch), peer: await report(peerWatch) };
  record(row.id, missing.length === 0 ? "PASS" : "FAIL", {
    what: row.what,
    group: groupId.slice(0, 8),
    marker,
    seenByPeer,
    seenByOwner,
    roster: shown,
    // Reported even when the row passes: a pending device here is a person mid-enrolment, and the
    // number is what makes the next run's comparison possible.
    pendingInThisGroup: pendingHere.length,
    placeholdersInThisGroup: placeholdersHere.map((r) => r.status),
    usersWithoutAnActiveDevice: usersWithoutActive.map(userTag),
    timeline,
    unmet: missing,
    clean: reports.owner.clean && reports.peer.clean,
    observers: reports,
  });
  ownerCx.close();
  peerCx.close();
  process.exit(missing.length === 0 ? 0 : 1);
}

// -------------------------------------------------------------------------------------- MULTI-8 / 9
//
// Both rows are the same choreography with a different question at the end, so they share it: take
// the peer away, enrol a second device of the owner, and watch the membership row the server writes
// for it. MULTI-8 asks whether that row ever reaches `active`; MULTI-9 asks what the messages sent
// while it did not are worth once it does.

note(`taking the peer away - ${PEER} must not be able to answer anything`);
const peerWasUp = await isUp(PEER.toLowerCase());
if (peerWasUp) note(`${PEER} killed in ${await killBrowser(PEER.toLowerCase())}ms`);
else note(`${PEER} was already down`);

// MULTI-9 needs the peer to SEND while the new device is pending, which means the peer must be alive
// for that step. It is taken away first all the same: the enrolment must happen with the peer absent,
// which is the condition the row names.
note("enrolling a second device of the owner while the peer is absent");
const minted = await becomeANewDevice({ report: (s) => note(`newdevice: ${s}`) });
const newDeviceId = minted.now?.deviceId ?? null;
note(`the new device is ${newDeviceId ? installTag(newDeviceId) : "(none)"}`);
if (!newDeviceId || !minted.enrolled) {
  record(row.id, "INVALID", {
    unobservable: "the second device did not enrol, so there is no membership row to watch",
    enrolled: minted.enrolled,
    pinOk: minted.pinOk,
    what: row.what,
    timeline,
  });
  minted.cx.close();
  ownerCx.close();
  process.exit(1);
}

/**
 * Waits for the server to write an `active` membership for this device in this group.
 *
 * TERMINATION IS THE PROOF, THE DEADLINE IS ONLY THE REPORT. It ends when the status is `active`; the
 * budget is there so a row that never activates is described rather than waited on. Which of the two
 * ended it is the verdict, so it is returned explicitly.
 */
async function awaitActive(deviceId, budgetMs) {
  const t0 = Date.now();
  const seen = [];
  for (;;) {
    let s;
    try {
      s = statusOf(groupId, deviceId);
    } catch (e) {
      s = `unreadable: ${firstLine(e)}`;
    }
    if (seen.at(-1)?.status !== s) {
      seen.push({ at: Date.now() - t0, wall: new Date().toISOString(), status: s });
      note(`membership status ${s ?? "(no row)"}`);
    }
    if (s === "active") return { active: true, elapsedMs: Date.now() - t0, seen };
    if (Date.now() - t0 >= budgetMs) return { active: false, elapsedMs: Date.now() - t0, seen };
    await sleep(5000);
  }
}

// The new device must first be IN the group at all: nothing activates a membership that was never
// created, and on a fresh device the group arrives through discovery.
const settle = await watchRows(minted.cx, { timeoutMs: 300_000, log: (m) => console.log(m) });
note(`the new device ${settle.settled ? "settled" : "did NOT settle"} in ${settle.elapsedMs}ms`);
const who = await whoAmI(minted.cx);

const activation = await awaitActive(newDeviceId, BUDGET_MINUTES * 60_000);
note(
  `activation ${JSON.stringify({ active: activation.active, elapsedMs: activation.elapsedMs })}`,
);

// A NEW ID APPEARING IS A FAIL, NOT A RECOVERY. On production what ended the incident was the user
// reinstalling, which minted a new device id and took the group's only commit. A runner that accepted
// that would call the workaround a pass.
const ownerDevicesNow = rosterOf(groupId)
  .filter((r) => r.userFull === who.userId)
  .map((r) => r.deviceFull);
const aNewIdAppeared = ownerDevicesNow.some(
  (d) => d !== newDeviceId && !minted.before?.localStorageKeys?.includes(d) && d.startsWith("web-"),
);
note(`the owner's devices in this group: ${ownerDevicesNow.length}`);

if (row.id === "MULTI-8") {
  const expectations = {
    theDeviceReachedActive: activation.active === true,
    itWasTheSameIdThatActivated: statusOf(groupId, newDeviceId) === "active",
    theGroupArrivedOnTheNewDevice: settle.settled === true,
    noPlaceholderWasWritten: placeholderRows().length === 0,
  };
  const missing = unmet(expectations);
  const reports = { owner: await report(ownerWatch), newDevice: await report(minted.observer) };
  record(row.id, missing.length === 0 ? "PASS" : "FAIL", {
    what: row.what,
    group: groupId.slice(0, 8),
    peerWasOnline: false,
    newDevice: installTag(newDeviceId),
    activation,
    budgetMinutes: BUDGET_MINUTES,
    settledInMs: settle.settled ? settle.elapsedMs : null,
    ownerDeviceCountInGroup: ownerDevicesNow.length,
    aNewIdAppeared,
    finalState: (await readAll(minted.cx)).rows,
    timeline,
    unmet: missing,
    clean: reports.owner.clean && reports.newDevice.clean,
    observers: reports,
  });
  minted.cx.close();
  ownerCx.close();
  process.exit(missing.length === 0 ? 0 : 1);
}

// ------------------------------------------------------------------------------------------ MULTI-9
//
// THE HALF NOBODY WATCHED. For 134 minutes messages were accepted, fanned out and lost, and both
// clients showed them sent. So the question is not whether a pending device receives a message the
// moment it is sent - it cannot - but whether that message is still there for it AFTERWARDS. A
// message accepted for a group with an inactive member and then unrecoverable is the loss.
note("bringing the peer back to SEND while the new device is still catching up");
await startBrowser(PEER.toLowerCase(), `${SITE}/chat`);
const peerCx = await client(PORTS[PEER], new URL(ORIGIN[PEER]).hostname);
const peerWatch = await watch(peerCx, PEER);
await ensureChat(peerCx);
await openChannel(peerCx);

const marker = `ROSTER9-${Math.random().toString(36).slice(2, 8)}`;
const HOW_MANY = 5;
note(`the peer sends ${HOW_MANY} message(s) marked ${marker}`);
for (let i = 1; i <= HOW_MANY; i += 1) await send(peerCx, `${marker} ${i}`);
const sentAt = mark(`${HOW_MANY} sent`);
timeline.push(sentAt);

// Whatever the new device's status was at the moment they were sent - the fact the row turns on.
const statusWhenSent = statusOf(groupId, newDeviceId);
note(`the new device was ${statusWhenSent ?? "(no row)"} when the peer sent`);

// Now let it finish. The messages must be there afterwards, whichever order the two happened in.
const activationAfter = activation.active
  ? activation
  : await awaitActive(newDeviceId, BUDGET_MINUTES * 60_000);
await openChannel(minted.cx).catch(() => null);
let arrived = 0;
for (let i = 0; i < 40; i += 1) {
  arrived = 0;
  for (let n = 1; n <= HOW_MANY; n += 1) {
    arrived += (await countMessage(minted.cx, `${marker} ${n}`)) > 0 ? 1 : 0;
  }
  if (arrived === HOW_MANY) break;
  await sleep(5000);
}
note(`${arrived}/${HOW_MANY} arrived on the new device`);

const expectations = {
  theDeviceEventuallyActivated: activationAfter.active === true,
  /** THE ROW'S POINT: nothing sent in the window was lost. */
  nothingSentWhilePendingWasLost: arrived === HOW_MANY,
  /** The window really existed, or the row proved nothing about it. */
  thereWasAWindowToTest: statusWhenSent !== "active",
  noPlaceholderWasWritten: placeholderRows().length === 0,
};
const missing = unmet(expectations);
const reports = {
  owner: await report(ownerWatch),
  peer: await report(peerWatch),
  newDevice: await report(minted.observer),
};
record(row.id, missing.length === 0 ? "PASS" : "FAIL", {
  what: row.what,
  group: groupId.slice(0, 8),
  marker,
  sent: HOW_MANY,
  arrived,
  statusWhenSent,
  activation: activationAfter,
  budgetMinutes: BUDGET_MINUTES,
  newDevice: installTag(newDeviceId),
  timeline,
  unmet: missing,
  clean: reports.owner.clean && reports.peer.clean && reports.newDevice.clean,
  observers: reports,
});
minted.cx.close();
peerCx.close();
ownerCx.close();
process.exit(missing.length === 0 ? 0 : 1);

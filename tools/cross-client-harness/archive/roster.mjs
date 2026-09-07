#!/usr/bin/env node
/**
 * THE MEMBERSHIP TABLE ITSELF - the four rows nothing on this board could have caught.
 *
 *   bun roster.mjs --row 10    the whole-population invariant, no client needed
 *   bun roster.mjs --row 7     every device of both users is active, and none is a placeholder
 *   bun roster.mjs --row 8     a device enrolled while the PEER is offline still activates
 *   bun roster.mjs --row 9     what a message sent to a PENDING device is worth afterwards
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
import { APP_TAB, ensureChat, client, countMessage, openDM, send } from "../chat.mjs";
import { installTag, userTag } from "../devices.mjs";
import { isUp, killBrowser, startBrowser } from "../launch.mjs";
import { ACCOUNT_OF, ORIGIN, PORTS, SITE, peerNameFor } from "../names.mjs";
import { unlockClient } from "./pingate.mjs";
import { becomeANewDeviceAndConfirm } from "../newdevice.mjs";
import { onlineDevicesOf } from "./presence.mjs";
import { record, unmet } from "../results.mjs";
// `estate.mjs`, WHICH IS WHERE `psql` HAS ALWAYS LIVED. This file alone imported it from
// `ssh.mjs` - a leftover from when the rig reached PRODUCTION over SSH, before it moved to the
// local estate on 2026-09-03 - and `ssh.mjs` exports only `SSH` and `ssh`. So all four
// membership-table rows (MULTI-7, -8, -9, -10) died at module load with
// `Export named 'psql' not found`, recorded nothing, and had never once run.
import { psql } from "../estate.mjs";
import { readAll, watch as watchRows, whoAmI } from "./syncrows.mjs";
import { report, watch } from "../watch.mjs";

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
 * This is the state that breaks delivery in both directions: a user in a group with no active device
 * cannot be sent to, now or later.
 *
 * IT CARRIES THE SAME TWO DISCRIMINATORS AS THE PENDING COUNT BELOW, and until 2026-09-07 it carried
 * neither - which made one row apply a policy to half its own population and not to the other half.
 * A pair whose newest membership is three minutes old is not starved, it is mid-handshake, and the
 * budget is exactly the line that says so. A pair all of whose devices the gateway has never heard of
 * is a closed laptop: the same exclusion the pending count states out loud, for the same reason.
 * Neither is charity - both sets are REPORTED, with their oldest age, so nobody can read a clean
 * verdict as an empty table.
 *
 * `newestAge` is the age of the pair's MOST RECENT membership row, because that is the one the
 * budget is about: an old row beside a fresh one is a device that re-enrolled, not a stuck member.
 */
const usersWithNoActiveDevice = () =>
  rows(
    psql(
      `SELECT left("groupId"::text,8), "userId", count(*)::text, ` +
        `date_trunc('minute', now()-max("createdAt"))::text, ` +
        // A WORD, NOT A BOOLEAN CAST. `boolean::text` is `true`/`false` in psql and `t`/`f` in half
        // the documentation; the first version of this compared against 't', read every aged pair as
        // fresh and reported five five-day-old pairs as inside a fifteen-minute budget.
        `(CASE WHEN now()-max("createdAt") > interval '${BUDGET_MINUTES} minutes' THEN 'past' ELSE 'inside' END), ` +
        `string_agg("deviceId", ',') ` +
        `FROM dm_device_group_memberships GROUP BY "groupId", "userId" ` +
        `HAVING count(*) FILTER (WHERE status='active') = 0 ORDER BY 1`,
    ),
  ).map(([grp, usr, n, newestAge, pastBudget, devs]) => ({
    group: grp,
    user: userTag(usr),
    userFull: usr,
    devices: Number(n),
    deviceIds: devs.split(','),
    newestAge,
    pastBudget: pastBudget === 'past',
  }));

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

  // THE THREE-WAY SPLIT, because "no active device" has three causes and only one of them is this
  // product failing. Mid-handshake (inside the budget) is the system working; every device silent
  // for days is a closed laptop, the same exclusion the pending count states out loud; a pair whose
  // device the gateway is TALKING TO and which still holds no active membership is the defect.
  const starvedAll = usersWithNoActiveDevice();
  const starvedFresh = starvedAll.filter((s) => !s.pastBudget);
  const aged = starvedAll.filter((s) => s.pastBudget);
  const liveDevices = new Map();
  const starved = [];
  const starvedOnSilentDevices = [];
  for (const s of aged) {
    if (!liveDevices.has(s.userFull)) {
      try {
        liveDevices.set(s.userFull, new Set(onlineDevicesOf(s.userFull)));
      } catch (e) {
        liveDevices.set(s.userFull, null);
        note(`the gateway could not be asked about ${s.user}: ${firstLine(e)}`);
      }
    }
    const live = liveDevices.get(s.userFull);
    const shown = { group: s.group, user: s.user, devices: s.devices, newestAge: s.newestAge };
    // `null` is UNREADABLE, and it counts against the product: a presence this cannot read is not a
    // presence it may assume absent, or an unreachable gateway would silence the whole invariant.
    if (live === null) shown.presence = 'unreadable';
    if (live === null || s.deviceIds.some((d) => live.has(d))) starved.push(shown);
    else starvedOnSilentDevices.push(shown);
  }
  note(
    `(group, user) pairs with no active device: ${starvedAll.length} - ${starvedFresh.length} inside the ` +
      `${BUDGET_MINUTES} min budget, ${starvedOnSilentDevices.length} on devices the gateway is not talking to, ` +
      `${starved.length} counted against the product`,
  );
  for (const s of starved) note(`  starved ${JSON.stringify(s)}`);
  for (const s of starvedOnSilentDevices) note(`  starved-but-silent ${JSON.stringify(s)}`);

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
    // A DECISION, NOT AN OMISSION - and it only became visible once this row could pass at all. It
    // drives no client and sends no traffic: there is no console for `gate()` to read, so a PASS
    // here would be demoted to `UNOBSERVED` for ever by a rule written about rows that HAVE one. The
    // evidence is the table, and it is in this record in full: three sets, each with the exclusion
    // that produced it named beside it.
    unobservable:
      "reads the membership table across the whole estate and drives no client - the evidence is the " +
      "three sets below, not a console",
    budgetMinutes: BUDGET_MINUTES,
    population: { total, active, pending },
    placeholders,
    starved,
    // REPORTED, NEVER FORGIVEN SILENTLY. A clean verdict on this row must not be readable as an
    // empty table: these two sets are the ones the predicate deliberately does not count, with the
    // oldest age each, so the next reader can see the shape of what was excluded.
    starvedInsideTheBudget: starvedFresh.map((s) => ({ group: s.group, user: s.user, newestAge: s.newestAge })),
    starvedOnSilentDevices,
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

/**
 * The conversation both accounts are really in, resolved from the TABLE rather than from a URL.
 *
 * A COMMUNITY CHANNEL IS THE WRONG OBJECT, and this row asked about it for a day. `general`'s
 * key-distribution group is workspace-scoped - `dm_groups.distributionWorkspaceId` - and it carries
 * ZERO `dm_group_members` rows, because a community's membership lives in `channel_members` instead.
 * So `rosterOf(theChannel)` compared 0 authoritative members against 7 device rows and every
 * assertion here was about an empty set. Measured 2026-08-28: the channel id `064ac7d2` appears in
 * neither membership table, and its workspace group `315b8a1d` has 0 members and 7 device rows.
 *
 * SO THE VENUE IS THE OWNER-PEER CONVERSATION, which is a `dm_groups` row with both users in
 * `dm_group_members` and one device row per enrolled device - the exact shape these three rows read.
 * It is also a USED group, which is what MULTI-7 asks for by name, and it needs no minting: it
 * already exists, both accounts are in it, and its identity follows from the two accounts.
 *
 * RESOLVED BY MEMBERSHIP, NOT BY NAME OR BY POSITION. `dm_groups.name` for a DM is the canonical
 * `ownerHash::peerHash` pair, so it could be spelt - but spelling it would put two account hashes in
 * a public repository and would break the day the pair is ordered the other way. The user ids come
 * from the clients themselves (`whoAmI`), so nothing here is hard-coded and nothing is guessed.
 */
function theConversationBetween(ownerId, peerId) {
  return rows(
    psql(
      `SELECT g.id FROM dm_groups g ` +
        `JOIN dm_group_members a ON a."groupId" = g.id AND a."userId" = '${ownerId}' ` +
        `JOIN dm_group_members b ON b."groupId" = g.id AND b."userId" = '${peerId}' ` +
        `WHERE g."isGroup" = false AND g."deletedAt" IS NULL ` +
        `AND (SELECT count(*) FROM dm_group_members m WHERE m."groupId" = g.id) = 2 ` +
        `ORDER BY g."activeEpoch" DESC`,
    ),
  )
    .map((r) => r[0].trim())
    .filter(Boolean);
}

const ownerCx = await client(PORTS[OWNER], new URL(ORIGIN[OWNER]).hostname);
const ownerWatch = await watch(ownerCx, OWNER);
await ensureChat(ownerCx);

const me = await whoAmI(ownerCx);
const peerProbe = await client(PORTS[PEER], new URL(ORIGIN[PEER]).hostname);
const them = await whoAmI(peerProbe);
peerProbe.close();
note(`the two accounts: ${userTag(me.userId)} and ${userTag(them.userId)}`);

const candidates =
  me.userId && them.userId ? theConversationBetween(me.userId, them.userId) : [];
note(`conversations between them: ${candidates.length}`);

// MORE THAN ONE IS NOT A VENUE, IT IS AN AMBIGUITY, and picking the first would make the row's
// subject depend on an ORDER BY. Neither zero nor two is a product defect these rows can speak to, so
// both are unobservable rather than failures.
if (candidates.length !== 1) {
  record(row.id, "INVALID", {
    unobservable:
      candidates.length === 0
        ? "the two accounts share no live conversation, so there is no roster to read"
        : `the two accounts share ${candidates.length} live conversations, so no single roster is THE roster`,
    accounts: [userTag(me.userId), userTag(them.userId)],
    what: row.what,
    timeline,
  });
  ownerCx.close();
  process.exit(1);
}
const groupId = candidates[0];
note(`the venue conversation is ${groupId.slice(0, 8)}`);
await openDM(ownerCx, peerNameFor(OWNER));

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
  await openDM(peerCx, peerNameFor(PEER));

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

/**
 * Puts the peer back on its feet, whatever this row decided.
 *
 * MULTI-8 KILLED IT AND EXITED, so the estate was left one browser short and the NEXT row refused to
 * start: on 2026-09-07 `roster.mjs --row 9` never ran at all, its preflight reporting "W2:
 * unreachable on 9223 - browser closed?". The row was right to refuse - an unknown client state is
 * exactly what it must not measure through - but the state was the previous row's litter. MULTI-9
 * always restored the peer because it NEEDS it to send; MULTI-8 has no such need and therefore had
 * no such line, which is the whole shape of the defect: a teardown that exists only where the row
 * happens to want it is not a teardown.
 *
 * Called on every exit path of MULTI-8, including the INVALID one - an enrolment that failed leaves
 * the estate just as broken as one that succeeded.
 */
const restorePeer = async () => {
  if (!peerWasUp) return "the peer was already down when this row started";
  await startBrowser(PEER.toLowerCase(), `${SITE}/chat`);
  // IT COMES BACK LOCKED, and saying so is the point: a fresh browser mounts `#encryption-pin`, so
  // this restores the ESTATE (a client the next preflight can find and repair) and not a usable
  // client. Nothing in this row touches the peer afterwards; the row that does - MULTI-9 - unlocks
  // it itself, because waiting for a gate to open on its own is thirty seconds spent proving it is
  // shut.
  return `${PEER} brought back, at its PIN gate`;
};

// MULTI-9 needs the peer to SEND while the new device is pending, which means the peer must be alive
// for that step. It is taken away first all the same: the enrolment must happen with the peer absent,
// which is the condition the row names.
note("enrolling a second device of the owner while the peer is absent");
// BOTH HALVES, AND THAT IS WHAT THE `AndConfirm` IS FOR. The mint was split at the live client on
// 2026-08-29 so HEAL-NEW-15 could observe between the halves; this row has nothing to ask there, and
// calling only the first half left `now` and `enrolled` undefined - so the guard below refused MULTI-8
// and MULTI-9 unconditionally, on a device that had enrolled perfectly. A caller with no question to
// ask in between calls the pair, which is the whole reason the pair exists.
const minted = await becomeANewDeviceAndConfirm({ report: (s) => note(`newdevice: ${s}`) });
const newDeviceId = minted.now?.deviceId ?? null;
note(`the new device is ${newDeviceId ? installTag(newDeviceId) : "(none)"}`);
if (!newDeviceId || !minted.enrolled) {
  record(row.id, "INVALID", {
    unobservable: "the second device did not enrol, so there is no membership row to watch",
    enrolled: minted.enrolled,
    pinOk: minted.pinOk,
    what: row.what,
    timeline,
    peerRestored: await restorePeer(),
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
    peerRestored: await restorePeer(),
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

// A BROWSER THAT HAS JUST BEEN LAUNCHED IS AT THE PIN GATE, and this row proceeded as though it
// were a working client. `goto` printed "no gateway connection line within 30 s - the client may
// still be coming up" and carried on, so `openDM` hunted for the owner's row behind a modal:
// `the peer's conversation row was never listed within 20000ms ... listedEntries: 14` (2026-09-07),
// which reads as a missing conversation and is a locked browser.
//
// AND WAITING WAS NOT THE ANSWER, WHICH IS WHY THE FIRST FIX FAILED TOO. `awaitAppReady` is false
// for exactly as long as `#encryption-pin` is mounted, so polling it just spent thirty seconds
// proving the gate was up. A relaunched browser does not become ready on its own - somebody has to
// let it in - and `unlockClient` both does that and PROVES the client came out the other side,
// which a client that renders and reports on an empty store otherwise hides.
const gate = await unlockClient(peerCx, PORTS[PEER], ACCOUNT_OF[PEER], { match: APP_TAB });
if (gate.verdict !== "unlocked") {
  record(row.id, "INVALID", {
    unobservable: "the peer browser was restarted and never got past its PIN gate, so it could not send",
    gate: gate.verdict,
    said: gate.said,
    what: row.what,
    timeline,
  });
  peerCx.close();
  minted.cx.close();
  ownerCx.close();
  process.exit(1);
}
note(`the peer is up again and unlocked (${gate.said})`);
await ensureChat(peerCx);
await openDM(peerCx, peerNameFor(PEER));

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
await openDM(minted.cx, peerNameFor(OWNER)).catch(() => null);
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

/**
 * A WINDOW THAT NO LONGER EXISTS IS NOT A FAILURE OF THE THING THAT CLOSED IT.
 *
 * This row was written after a device sat `pending` for 134 MINUTES while messages were accepted,
 * fanned out and lost. On 2026-09-07 the same device reached `active` in 105 ms - so the peer,
 * restarted and unlocked in the seconds it took to get there, could only ever send into an ACTIVE
 * membership, and `thereWasAWindowToTest` was false. Every other expectation held and 5 of 5
 * arrived.
 *
 * Recording FAIL for that would be the board accusing the product of the fix. `VACUOUS` is the
 * verdict this rig already reserves for a check that could not create its own precondition - the
 * same distinction `idb.mjs` draws between "no rows" and "no such store" - and it is NOT a softer
 * PASS: the row still says, in the same record, how fast the activation was, which is the number
 * that made the window vanish.
 *
 * THE SAME SHAPE THE HEAL-NEW RUNG ALREADY HIT, and it is not a coincidence. A device now reaches
 * every group it belongs to with nothing of its own online, because some OTHER member commits the
 * add within milliseconds - the owner held five devices in this group when this ran. So every row
 * whose subject is what happens DURING a catch-up needs a group the device cannot self-serve, which
 * is an open item in `backlog.md` for HEAL-NEW and is now this row's too. Holding the window open
 * here would mean taking every other member's device off the air, which is a fixture, not a tweak.
 *
 * AND IT CANNOT HIDE A REGRESSION, because the two failures it must never absorb are separate
 * expectations that are checked FIRST: a device that never activates fails
 * `theDeviceEventuallyActivated`, and a message lost in a window that DID exist fails
 * `nothingSentWhilePendingWasLost`. Only the case where the sole unmet expectation is the window
 * itself is vacuous.
 */
const onlyTheWindowIsMissing = missing.length === 1 && missing[0].startsWith("thereWasAWindowToTest");
const verdict = missing.length === 0 ? "PASS" : onlyTheWindowIsMissing ? "VACUOUS" : "FAIL";
record(row.id, verdict, {
  ...(onlyTheWindowIsMissing
    ? {
        why:
          `the new device reached active in ${activation.elapsedMs} ms, so there was no pending ` +
          "window to send into - the row's premise cannot be created on a healthy estate",
      }
    : {}),
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

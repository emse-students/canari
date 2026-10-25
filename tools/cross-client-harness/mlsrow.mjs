/**
 * THE KERNEL EVERY 1.4.1 ROW RUNNER STANDS ON - seats, ownership, the group a row mints, the reads.
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 has about seventy rows in twelve groups, and
 * they share everything but their action: open the seats the row names and watch them from the first
 * line, touch only what the campaign owns on a shared estate (R5), read the server's view of the
 * group before and after, run the invariant of section 4.0 on every client in play (R8), and hand
 * `recordObserved` reports it can gate - client windows, the deploy exclusion (R4, inside `gate()`)
 * and the server window judged BY THE ROW (R6, `serverWindowSince` plus the row id). So a runner is
 * one table and one action per row (`archive/floor.mjs` is the first), and this file is the rest.
 *
 * IT RECORDS NOTHING: a runner owns its verdict (`results.mjs`), and this stays a library the
 * inventory files with the atoms. The pure half - names, verdict composition - is `rowkit.mjs`.
 *
 * REFUSES ANY ESTATE BUT LOCAL OR DEV: `site.mjs` throws at import on production (R1), and the
 * estate is re-asserted below so a future third value is not driven by accident.
 */
import { subjectFor } from './accounts.mjs';
import { assertCampaignOwned, ledger, recordCreated } from './campaign.mjs';
import { client, evaluate, until } from './chat.mjs';
import { armIfPhone, resolveDevices, tabMatchFor } from './device.mjs';
import { psql, srvLines } from './estate.mjs';
import { armFault } from './fault.mjs';
import { createGroup } from './groupnav.mjs';
import { serverView } from './invariant.mjs';
import { forgivingProvoked, rowGroupName } from './rowkit.mjs';
import { ESTATE } from './site.mjs';
import {
  PAGE_BOOT_NARRATION,
  ignoringExpectedLog,
  ignoringExpectedRefusal,
  ignoringOfflineCut,
  report,
  watch,
} from './watch.mjs';

if (ESTATE !== 'local' && ESTATE !== 'dev') throw new Error(`mlsrow.mjs drives the local or the dev estate only, not '${ESTATE}'`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A USER id is NOT a uuid: the server keys an account by the 64-hex digest of its identity-provider
 * subject (measured on dev, 2026-10-25 - every FLOOR draw died on the uuid test before it acted).
 * A uuid is still accepted for the older shape. The test exists because the id is spliced into SQL.
 */
const USER_ID = /^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const rows = (out) =>
  String(out)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|'));

/**
 * Opens and WATCHES every seat a row names, in order, before the row acts - so the console of the
 * whole row is judged, not only the invariant probe's seconds. A phone is armed first (`armIfPhone`).
 *
 * @param {string[]} devices seat names (`W1`, `W4`, `A1`...) as `names.mjs` `PORTS` holds them
 * @param {string} label the row id, prefixed to every watcher
 * @returns {Promise<{targets: object[], seat: Record<string, {target: object, cx: object, w: object}>}>}
 */
export async function openSeats(devices, label) {
  const targets = resolveDevices(['--device', devices.join(',')]);
  const seat = {};
  for (const target of targets) {
    await armIfPhone(target, `${label}:${target.device}`);
    const cx = await client(target.port, tabMatchFor(target), { focus: false });
    const w = await watch(cx, `${label}:${target.device}`);
    seat[target.device] = { target, cx, w };
  }
  return { targets, seat };
}

/** The `watch()` handles by device, the shape `checkInvariant({watchers})` takes. */
export const watchersOf = (seats) => Object.fromEntries(Object.entries(seats.seat).map(([d, s]) => [d, s.w]));

/**
 * The finished, row-forgiven report of every seat, in the shape `recordObserved` gates: a report
 * carrying `clean`, with its `cx` kept so the stale-bundle check still reaches the client. Call it
 * AFTER the invariant - `report()` drains the events the invariant reads.
 *
 * @param {object} seats from {@link openSeats}
 * @param {{refusals?: Record<string, {path: RegExp, status: number[]}[]>, logs?: Record<string, (string|RegExp)[]>,
 *   provoked?: Record<string, object[]>, offline?: string[]}} [forgive]
 *   per device: the refusals and the narration THIS row provokes there, the records of the faults it
 *   armed there (`rowkit.mjs` `forgivingProvoked`, one line each), and the devices it cut on purpose
 *   (`ignoringOfflineCut`) - and nothing wider
 */
export async function observersOf(seats, { refusals = {}, logs = {}, provoked = {}, offline = [] } = {}) {
  const out = {};
  for (const [device, s] of Object.entries(seats.seat)) {
    let rep = await report(s.w);
    // EVERY MLS ROW RELOADS ITS WEB SEATS (the invariant's second pass, R8), and a reloaded page
    // narrates its boot (`PAGE_BOOT_NARRATION`). Read off the window's OWN navigations rather than
    // asked of each runner: a seat whose window saw no document replaced gets no forgiveness, so a
    // page that booted unasked is still a finding. Met on the first live FLOOR draw (2026-10-25).
    if ((rep.documentsReplaced ?? 0) > 0) rep = ignoringExpectedLog(rep, PAGE_BOOT_NARRATION);
    if (offline.includes(device)) rep = ignoringOfflineCut(rep);
    if (provoked[device]?.length) rep = forgivingProvoked(rep, provoked[device]);
    if (refusals[device]?.length) rep = ignoringExpectedRefusal(rep, refusals[device]);
    if (logs[device]?.length) rep = ignoringExpectedLog(rep, logs[device]);
    out[device] = { ...rep, cx: s.cx };
  }
  return out;
}

/** Closes every seat's connection. Never throws: it runs after the row is on disk. */
export function closeSeats(seats) {
  for (const s of Object.values(seats?.seat ?? {})) {
    try {
      s.cx.close();
    } catch (e) {
      console.log(`[mlsrow] closing ${s.target.device}: ${String(e?.message ?? e)}`);
    }
  }
}

/** The user id the server knows a seat's account by (`test-accounts.json` `sub`, never a display name). */
export const userOf = (seats, device) => subjectFor(seats.seat[device].target.account);

/** A user's display name as the server stores it - what the member picker and a DM's sidebar show. */
export function displayNameOf(userId) {
  if (!USER_ID.test(userId)) throw new Error(`displayNameOf: '${userId}' is not a user id`);
  const name = rows(psql(`SELECT "displayName" FROM users WHERE id = '${userId}'`))[0]?.[0] ?? null;
  if (!name) throw new Error(`displayNameOf: no display name for ${userId.slice(0, 8)}`);
  return name;
}

/**
 * The id of the live group `name` that `memberUserId` belongs to. Ambiguity is a throw: two live
 * groups of one name would make every later read about one of them by chance.
 */
export function liveGroupIdByName(name, memberUserId) {
  const found = rows(
    psql(
      `SELECT g.id FROM dm_groups g WHERE g.name = '${name.replace(/'/g, "''")}' AND g."deletedAt" IS NULL ` +
        `AND EXISTS (SELECT 1 FROM dm_group_members m WHERE m."groupId" = g.id AND m."userId" = '${memberUserId}')`
    )
  );
  if (found.length > 1) throw new Error(`${found.length} live groups named ${name} hold ${memberUserId.slice(0, 8)} - resolve by hand`);
  return found[0]?.[0] ?? null;
}

/** The name of the live group `groupId`, or null - for a row handed an id (`--group`). */
export function groupNameOf(groupId) {
  if (!UUID.test(groupId)) throw new Error(`groupNameOf: '${groupId}' is not a group id`);
  return rows(psql(`SELECT name FROM dm_groups WHERE id = '${groupId}' AND "deletedAt" IS NULL`))[0]?.[0] ?? null;
}

/**
 * The device id a seat's page holds for `userId` (`mls_device_id_<user>`), or null when that account
 * has no enrolled device there - the id the server's seats are keyed by.
 */
export async function deviceIdOf(cx, userId) {
  const v = await evaluate(cx, `localStorage.getItem(${JSON.stringify(`mls_device_id_${userId}`)}) || ''`);
  return v || null;
}

/**
 * R5 FOR A ROW THAT WRITES: a commit or a message is a write on a shared estate, so a row acts only in
 * a conversation the campaign owns - a fixture (`campaign-fixtures.mjs`) or a group a row minted. On
 * local the ledger is written but not required (`campaign-ledger.mjs`).
 *
 * @param {{kind: 'group'|'dm', id?: string, name?: string}} target
 * @param {string} rowId
 */
export const assertRowOwns = (target, rowId) => assertCampaignOwned(target, rowId);

/**
 * Mints the row's OWN group from `cx` (`rowGroupName`, swept by `debris.mjs`) and returns its name and
 * server id. `createGroup` records the name in the campaign ledger the moment the sidebar names it;
 * the id is recorded beside it once the server answers, so a later deletion is matched by id.
 */
export async function mintRowGroup(cx, rowId, creatorUserId) {
  const name = rowGroupName(rowId);
  await createGroup(cx, name, { label: rowId });
  let id = null;
  for (let i = 0; i < 40 && !id; i++) {
    id = liveGroupIdByName(name, creatorUserId);
    if (!id) await new Promise((r) => setTimeout(r, 500));
  }
  if (!id) throw new Error(`${rowId}: ${name} is listed on the creator but the server holds no such group after 20 s`);
  recordCreated({ kind: 'group', id, name, by: rowId });
  return { name, id };
}

/** The newest group the ledger says `rowId` minted, or null - how a row reuses an earlier row's group. */
export function lastGroupMintedBy(rowId) {
  const mine = ledger().filter((e) => e.kind === 'group' && e.by === rowId && e.id && e.name);
  return mine.length ? { name: mine[mine.length - 1].name, id: mine[mine.length - 1].id } : null;
}

/** Waits until a client's sidebar names `name` (a joiner received its Welcome); the elapsed ms or null. */
export async function awaitListed(cx, name, timeoutMs = 60_000) {
  try {
    return await until(cx, `document.body.innerText.indexOf(${JSON.stringify(name)}) !== -1`, timeoutMs, 250);
  } catch {
    return null;
  }
}

/**
 * Waits until the server's view of `group` satisfies `predicate` (a commit landed, a seat went
 * active), and returns that view - or the last one read, with `settled: false`, at the bound. A row
 * judges the view; it never sleeps a guess.
 */
export async function awaitServer(group, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let view = serverView(group);
  while (!predicate(view)) {
    if (Date.now() > deadline) return { ...view, settled: false };
    await new Promise((r) => setTimeout(r, 500));
    view = serverView(group);
  }
  return { ...view, settled: true };
}

/**
 * The delivery service's `[COMMIT]` lines for `group` since `since` - the server's own account of
 * each submission (`ACCEPT`, `REJECT epoch_mismatch`, `DUPLICATE`...), which a row counts.
 */
export function commitLines(group, since) {
  if (!UUID.test(group)) throw new Error(`commitLines: '${group}' is not a group id`);
  return srvLines('chat-delivery-service', since).filter((l) => /\[COMMIT\]/.test(l) && l.includes(`group=${group}`));
}

/** The commit POST, and only it: `GET /api/mls/commits/:groupId` shares the prefix, so the method is named. */
export const COMMIT_POST = { match: '/api/mls/commit', method: 'POST' };

/**
 * RELEASES SEVERAL COMMITS TOGETHER - the action of every "same epoch" race (CC-*, RM-1, RM-7).
 *
 * Each `actions[device]` is a gesture that ends in ONE commit on that seat (an Add, a Remove, a send
 * that triggers a due refresh). Every seat's commit POST is held BEFORE the server (`fault.mjs`
 * `hold once`), the gestures are started together and NOT awaited, and once EVERY seat holds its
 * request they are released in one `Promise.all` - so the server sees them within one round trip,
 * both built on the same epoch. A rebuilt retry after a refusal is not held (`once`).
 *
 * A seat whose request never arrived is not a race: the gestures are still awaited and the faults
 * disarmed, and `vacuous` names it, which `composeVerdict` turns into `VACUOUS`.
 *
 * @param {object} seats from {@link openSeats}
 * @param {Record<string, () => Promise<unknown>>} actions device -> the gesture, started here
 * @param {{heldWithinMs?: number}} [opt] how long every seat is given to reach its POST
 * @returns {Promise<{releasedAt: string|null, outcomes: Record<string, {ok: boolean, value?: unknown, error?: string}>,
 *   vacuous: {device: string, rule: number, fault: string}[], records: Record<string, object[]>}>}
 */
export async function raceCommits(seats, actions, { heldWithinMs = 45_000 } = {}) {
  const devices = Object.keys(actions);
  const faults = {};
  for (const d of devices) faults[d] = await armFault(seats.seat[d].cx, [{ ...COMMIT_POST, fault: 'hold once' }]);
  const running = Object.fromEntries(
    devices.map((d) => [
      d,
      actions[d]().then(
        (value) => ({ ok: true, value }),
        (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 300) })
      ),
    ])
  );
  let releasedAt = null;
  let failure = null;
  try {
    const held = await Promise.allSettled(devices.map((d) => faults[d].awaitHeld(1, heldWithinMs)));
    const missing = devices.filter((_, i) => held[i].status === 'rejected');
    if (missing.length) console.log(`[race] no commit held on ${missing.join(' ')} within ${heldWithinMs} ms - not a race`);
    releasedAt = new Date().toISOString();
    await Promise.all(devices.map((d) => faults[d].release()));
    console.log(`[race] released ${devices.join(' + ')} together at ${releasedAt}`);
  } catch (e) {
    failure = e;
  }
  // DISARMED WHATEVER HAPPENED: a fault left armed would hold the page's next commit. The gestures
  // first, which end on their own post-conditions once their request is let go.
  const outcomes = {};
  for (const d of devices) outcomes[d] = await running[d];
  const vacuous = [];
  const records = {};
  for (const d of devices) {
    const rep = await faults[d].disarm();
    records[d] = rep.records;
    for (const i of rep.vacuous) vacuous.push({ device: d, rule: i, fault: `${d} hold once` });
  }
  if (failure) throw failure;
  return { releasedAt, outcomes, vacuous, records };
}

/**
 * This seat's leaf-refresh ledger entry for `groupId` (`leafRefresh.ts`, the device's own
 * `localStorage`, key `mls_leaf_refresh:<user>:<device>`), or null.
 */
export async function leafLedgerEntry(cx, userId, deviceId, groupId) {
  const raw = await evaluate(cx, `localStorage.getItem(${JSON.stringify(`mls_leaf_refresh:${userId}:${deviceId}`)})`);
  if (!raw) return null;
  return JSON.parse(raw)[groupId] ?? null;
}

/**
 * ARMS A DUE LEAF REFRESH ON A CAMPAIGN DEVICE (CC-4), with no server write.
 *
 * The refresh ledger is the device's own `localStorage`, NOT a Redis key (plan Q3's premise was
 * wrong). A leaf this device's OWN commit produced is due at `at + 7 days` (`decideLeafRefresh`,
 * basis `ledger`), so moving `at` back eight days makes it due at the device's next durable send. A
 * KeyPackage-dated leaf (a device that only received a Welcome) is dated by the TREE and cannot be
 * armed this way: refused, never faked.
 *
 * @returns {Promise<{before: object, after: object}>} the entry before and after the rewrite
 */
export async function armLeafRefresh(cx, userId, deviceId, groupId, { ageDays = 8 } = {}) {
  const before = await leafLedgerEntry(cx, userId, deviceId, groupId);
  if (!before) throw new Error(`armLeafRefresh: no ledger entry for ${groupId.slice(0, 8)} on this device - it has made no commit there`);
  if (before.observed) throw new Error(`armLeafRefresh: the entry for ${groupId.slice(0, 8)} is an OBSERVATION - this device's leaf is not one its own commit produced`);
  const key = `mls_leaf_refresh:${userId}:${deviceId}`;
  const at = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  await evaluate(
    cx,
    `(function () { var l = JSON.parse(localStorage.getItem(${JSON.stringify(key)})); l[${JSON.stringify(groupId)}].at = ${at}; localStorage.setItem(${JSON.stringify(key)}, JSON.stringify(l)); return true; })()`
  );
  return { before, after: await leafLedgerEntry(cx, userId, deviceId, groupId) };
}

/**
 * Waits until a client's OWN MLS state holds `groupId` at `epoch` or later (`window.__canariMlsEpochs`),
 * and returns the elapsed ms - or null at the bound. A row that needs a member to commit ON TOP of
 * another commit (DUP-2) waits for this, so a refusal it then sees is the product's and not a member
 * that had simply not received the commit yet.
 */
export async function awaitClientEpoch(cx, groupId, epoch, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const at = Number(await evaluate(cx, `(function () { try { var e = window.__canariMlsEpochs && window.__canariMlsEpochs(); return e && e[${JSON.stringify(groupId)}] !== undefined ? e[${JSON.stringify(groupId)}] : -1; } catch (x) { return -1; } })()`));
    if (at >= epoch) return Date.now() - started;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export { serverView };

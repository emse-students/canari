/**
 * THE DEVICE ROWS OF THE 1.4.1 CAMPAIGN - a new device of the owner, seated, revoked, raced, and
 * answered from a phone in the background.
 *
 *   bun archive/devrows.mjs --row DEV-1|DEV-2|DEV-3|DEV-4|DEV-6|DUP-7      # browsers
 *   bun archive/devrows.mjs --row DEV-7 --variant cold|opened|stale       # A1 swiped away (class B)
 *
 * `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2; the table and every judge are `devicerows.mjs`.
 * DEV-5 is not here (`DEV5_ELSEWHERE`).
 *
 * EVERY MINT IS ITS OWN PROCESS (`archive/mintdevice.mjs`), because `newdevice.mjs` binds its device
 * from `--device` at import and DEV-4 needs two at the same instant. The minted device's seat is
 * opened and WATCHED BEFORE the mint, so its whole join - the Welcome it receives, the lines DUP-7
 * counts - is in the row's window; the wipe navigates the same page and the watch stays on it.
 *
 * A REVOKE GOES THROUGH `purge-devices.mjs`, the product's own panel, from W1 - and the panel's
 * allowlist is the campaign ledger, so only a device a mint recorded can be revoked.
 *
 * Only the owner's WIPEABLE seats are minted on (W3, W6). W6 is the 1.4.1 campaign's second scratch
 * profile of the owner account: `names.mjs` must declare it, and its CAS session costs one human
 * sign-in the first time.
 */
import { spawn, spawnSync } from 'node:child_process';
import { APP_TAB, evaluate, paneOccurrences, send } from '../chat.mjs';
import { reloadAndWait } from '../cdp.mjs';
import {
  BG_WELCOME,
  DEVICE_ID_NOW,
  DEV_ROWS,
  appearances,
  bgAnswered,
  bgWelcomeOwn,
  bgWelcomeTrace,
  deviceAddedOwn,
  deviceSeat,
  mintedLine,
  offlineRevokeOwn,
  originalArrivalOwn,
  raceEnrolOwn,
  reenrolledDevice,
  revokedOwn,
  addAcrossReloadPremise,
  commitLinesBy,
  dup7Narration,
  welcomeAcrossReloadOwn,
} from '../devicerows.mjs';
import { recordCreated } from '../campaign.mjs';
import { dismissMintedNoticesOn } from '../devicenotice.mjs';
import { srvLines } from '../estate.mjs';
import { armFault } from '../fault.mjs';
import { closeOverlays, openGroup } from '../groupnav.mjs';
import { checkInvariant, receivedOn } from '../invariant.mjs';
import { welcomeLines } from '../killrows.mjs';
import {
  COMMIT_POST,
  armLeafRefresh,
  assertRowOwns,
  awaitClientEpoch,
  awaitListed,
  awaitServer,
  closeSeats,
  commitLines,
  deviceIdOf,
  displayNameOf,
  mintRowGroup,
  observersOf,
  openSeats,
  serverView,
  userOf,
  watchersOf,
} from '../mlsrow.mjs';
import { errorDetail, finishObserved, record } from '../results.mjs';
import { composeVerdict, invariantDetail, rowMessageMark } from '../rowkit.mjs';
import { HARNESS_ROOT, requireScript } from '../scriptpath.mjs';
import { commitSequence } from '../settlerows.mjs';
import {
  AUTH_TEARDOWN_NARRATION,
  BLOCK_LIST_READ_NARRATION,
  CONTACT_DEVICE_NOTICE_NARRATION,
  DEVICE_PANEL_NARRATION,
  FRESH_CLIENT_NARRATION,
  FRESH_DEVICE_RESTORE_NARRATION,
  FRESH_DEVICE_SESSION_NARRATION,
  GROUP_CREATION_NARRATION,
  IDP_CONSOLE_NARRATION,
  MINT_REFUSALS,
  NO_LOCAL_STATE_NARRATION,
  OIDC_LOGIN_NARRATION,
  OWNER_DEVICE_NOTICE_NARRATION,
  REVOKED_RETURN_NARRATION,
  REVOKED_REFUSALS,
  REVOKED_SIGN_OUT_NARRATION,
  revokedLogoutOnce,
  signOutCount,
  mintedKeyPackageVettedNarration,
  consoleLines,
  logcatSince,
} from '../watch.mjs';
import { addMembers } from './addmember.mjs';
import { armCutOnNextLoad, cutHard } from './net.mjs';
import { unlockClient } from './pingate.mjs';
import { killSeat, reviveSeat } from './reopen.mjs';

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : null);
const id = opt('row');
if (!DEV_ROWS[id]) {
  console.error(`usage: bun archive/devrows.mjs --row ${Object.keys(DEV_ROWS).join('|')} [--variant ...]`);
  process.exit(2);
}
const spec = DEV_ROWS[id];
const variant = opt('variant');
if (spec.variants && !spec.variants.includes(variant)) {
  console.error(`${id} needs --variant ${spec.variants.join('|')}`);
  process.exit(2);
}
const rowId = variant ? `${id}-${variant}` : id;
const since = new Date().toISOString();
let seats = null;
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a freshly minted device says: the wipe, the OIDC callback, a cold client, the abandoned id's purge. */
const MINT_NARRATION = [
  ...IDP_CONSOLE_NARRATION,
  ...NO_LOCAL_STATE_NARRATION,
  ...OIDC_LOGIN_NARRATION,
  ...DEVICE_PANEL_NARRATION,
  ...FRESH_CLIENT_NARRATION,
  ...BLOCK_LIST_READ_NARRATION,
  ...FRESH_DEVICE_SESSION_NARRATION,
  ...FRESH_DEVICE_RESTORE_NARRATION,
];
/** ... and, on the one device a row revoked, its own account of being revoked and erasing itself. */
const REVOKED_NARRATION = [...MINT_NARRATION, ...REVOKED_RETURN_NARRATION, ...AUTH_TEARDOWN_NARRATION, ...REVOKED_SIGN_OUT_NARRATION];

/** Polls `probe` until it is truthy; the elapsed ms, or null at the bound. */
async function within(probe, timeoutMs, everyMs = 1_000) {
  const t0 = Date.now();
  for (;;) {
    if (await probe()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

/**
 * Mints `device` in its own process and resolves with its `MINTED` line (`archive/mintdevice.mjs`),
 * or a refusal naming the exit when the child printed none. The child's output is relayed, prefixed.
 */
function mintOn(device) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [requireScript('mintdevice.mjs'), '--device', device], { cwd: HARNESS_ROOT });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(String(d).replace(/^/gm, `[${rowId}:mint ${device}] `));
    });
    p.stderr.on('data', (d) => process.stderr.write(String(d).replace(/^/gm, `[${rowId}:mint ${device}] `)));
    p.on('close', (code) => resolve({ device, exit: code, ...(mintedLine(out) ?? { refused: `mintdevice printed no MINTED line (exit ${code})`, enrolled: false, deviceId: null }) }));
  });
}

/** Revokes `deviceId` from `actor`'s device panel (`purge-devices.mjs`, whose allowlist is the ledger). */
function revokeFrom(actor, deviceId) {
  const r = spawnSync(process.execPath, [requireScript('purge-devices.mjs'), '--only', deviceId, '--port', String(seats.seat[actor].target.port)], {
    encoding: 'utf8',
    cwd: HARNESS_ROOT,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean);
  console.log(`[${rowId}] purge-devices --only ${deviceId.slice(0, 8)}... exit ${r.status}: ${out.at(-1) ?? ''}`);
  return { ok: r.status === 0, exit: r.status, tail: (out.at(-1) ?? '').slice(0, 200) };
}

/** Waits for `deviceId`'s seat in the group to reach (or leave) `active`; the elapsed ms or null. */
const seatActiveWithin = (groupId, deviceId, timeoutMs) => within(() => deviceSeat(serverView(groupId), deviceId) === 'active', timeoutMs);
const seatGoneWithin = (groupId, deviceId, timeoutMs) => within(() => deviceSeat(serverView(groupId), deviceId) !== 'active', timeoutMs);

/** Whether the client's own console says it was revoked and reset (`healrevoke.mjs` `classifyWipe` reads the same lines). */
const toldRevoked = (cx) => consoleLines(cx).some((l) => /\[SECURITY\] This device was revoked by its owner|\[RESET\] done|\[INIT\] Login failed \(device_revoked\)/.test(l));

/**
 * The `{ userId, deviceId }` a seat's storage names, or `null`. A read the page could not answer (it
 * is mid-reload after a wipe) is `null` and logged: it records no debris, the safe direction.
 */
async function seatDeviceId(cx) {
  try {
    return JSON.parse(await evaluate(cx, DEVICE_ID_NOW));
  } catch (e) {
    console.log(`[${rowId}] the seat's device id could not be read (${String(e).slice(0, 120)}) - taken as none`);
    return null;
  }
}

/** How many times `text` is on screen right now. */
const onScreen = (cx, text) => evaluate(cx, `(document.body.innerText.split(${JSON.stringify(text)}).length - 1)`).then(Number);

/** Samples `text` on screen every second for `ms`. */
async function sampleOnScreen(cx, text, ms) {
  const samples = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    samples.push(await onScreen(cx, text).catch(() => 0));
    await sleep(1_000);
  }
  return samples;
}

/** The minted seat reads `mark` in the group: listed, opened, counted. */
async function readsOn(device, c, mark, timeoutMs = 120_000) {
  const cx = seats.seat[device].cx;
  const listed = (await awaitListed(cx, c.group.name, timeoutMs)) !== null;
  if (!listed) return { listed, shown: 0 };
  await openGroup(cx, c.group.name, { label: rowId });
  for (let i = 0; i < 30; i++) {
    const n = (await receivedOn(cx, mark)).count;
    if (n > 0) return { listed, shown: n };
    await sleep(1_000);
  }
  return { listed, shown: 0 };
}

const ACTIONS = {
  /**
   * DEV-1: W3 minted; seated by itself; the owner's notice on W1 once; the device line in the row's
   * group once on W2 (a contact) and never on W1 - the owner is told by the notice, not by a line
   * (`deviceEventAudience`: own account -> `owner-alert`, a contact -> `contact-line`).
   */
  async 'DEV-1'(c) {
    const W1 = seats.seat.W1.cx;
    const noticeP = sampleOnScreen(W1, 'Nouvel appareil sur votre compte', 240_000);
    const minted = await mintOn('W3');
    if (!minted.enrolled) return { premise: [`W3 did not enrol: ${minted.refused ?? 'not enrolled'}`], detail: { minted } };
    const seatedMs = await seatActiveWithin(c.group.id, minted.deviceId, 120_000);
    const notice = appearances(await noticeP);
    const lines = {};
    for (const d of ['W1', 'W2']) {
      await openGroup(seats.seat[d].cx, c.group.name, { label: rowId });
      lines[d] = await paneOccurrences(seats.seat[d].cx, 'a ajouté un appareil');
    }
    return {
      members: ['W1', 'W2', 'W3'],
      minted: { W3: minted },
      detail: { minted, notice, lines },
      judge: () => deviceAddedOwn({ seatedMs, notice, lines }),
    };
  },

  /** DEV-2 / DEV-3: W3 minted and seated, then revoked from W1 - online, or while cut off. */
  async revoke(c) {
    const W3 = seats.seat.W3;
    if (spec.revoke === 'offline') await armCutOnNextLoad(W3.cx);
    const minted = await mintOn('W3');
    if (!minted.enrolled) return { premise: [`W3 did not enrol: ${minted.refused ?? 'not enrolled'}`], detail: { minted } };
    const seatedMs = await seatActiveWithin(c.group.id, minted.deviceId, 120_000);
    if (seatedMs === null) return { premise: ['W3 was never seated in the group, so there is nothing to revoke'], detail: { minted } };
    // WHOSE DEVICE THE SEAT IS, from its own storage before anything is revoked: the account the
    // return read below is compared against (`reenrolledDevice`).
    const enrolledAs = await seatDeviceId(W3.cx);
    let cut = null;
    if (spec.revoke === 'offline') cut = await cutHard(W3.cx);
    const revokedAt = now();
    const panel = revokeFrom('W1', minted.deviceId);
    const seatGoneMs = await seatGoneWithin(c.group.id, minted.deviceId, spec.seatBoundMs);
    // STILL CUT HERE: the seat went while W3 could hear nothing (DEV-3), and only now does it return.
    const cutHeld = cut !== null && (await evaluate(W3.cx, 'navigator.onLine')) === false;
    if (cut) await cut.restore();
    const toldMs = await within(() => toldRevoked(W3.cx), 90_000);
    const listedAfter = (await awaitListed(W3.cx, c.group.name, 5_000)) !== null;
    // A REVOKED SEAT THAT CAME BACK AS A NEW DEVICE (DEV-3 on alpha.3): the id its storage names now
    // is this row's debris, recorded so the ledger lets a later purge remove it - and only that id.
    const reenrolled = reenrolledDevice({
      mintedId: minted.deviceId,
      now: await seatDeviceId(W3.cx),
      ownerId: enrolledAs?.userId ?? null,
    });
    if (reenrolled) {
      recordCreated({ kind: 'device', id: reenrolled, by: 'devrows-reenrolled' });
      console.log(`[${rowId}] the revoked seat re-enrolled as ${reenrolled.slice(-13)} - recorded as this row's debris`);
    }
    const own = [
      ...(spec.revoke === 'offline' ? offlineRevokeOwn({ seatGoneMs, toldMs, listedAfter, cutHeld }) : revokedOwn({ seatGoneMs, toldMs, listedAfter })),
      { what: `the revoked device did not re-enrol under a fresh id (${reenrolled ? `RE-ENROLLED as ${reenrolled.slice(-13)}` : 'none'})`, ok: !reenrolled },
    ];
    return {
      members: ['W1', 'W2'],
      revoked: ['W3'],
      offline: cut ? ['W3'] : [],
      minted: { W3: minted },
      detail: { minted, revokedAt, panel, seatedMs, socketsClosed: cut?.socketsClosed ?? null, reenrolled },
      // THE SIGN-OUT IS COUNTED, NOT FORGIVEN BY A NEEDLE: the reset's own clearAuth is the one logout, and the
      // session-expired redirect adds none. Zero (never signed out) and two (the P3 of alpha.3) both fail.
      judge: () => [
        { what: `the panel revoked W3 (${panel.ok ? 'ok' : `exit ${panel.exit}: ${panel.tail}`})`, ok: panel.ok },
        ...own,
        (() => {
          const n = signOutCount(consoleLines(W3.cx));
          return { what: `the revoked device signed out exactly once (${n} logout line(s))`, ok: n === 1 };
        })(),
      ],
    };
  },

  /** DEV-4: W3 and W6 minted at the same instant; both seated, W1 at the server's epoch. */
  async 'DEV-4'(c) {
    const minted = await Promise.all(spec.mint.map((d) => mintOn(d)));
    const seated = {};
    for (const m of minted) seated[m.device] = m.deviceId ? await seatActiveWithin(c.group.id, m.deviceId, spec.seatBoundMs) : null;
    const ownerCaughtUpMs = await awaitClientEpoch(seats.seat.W1.cx, c.group.id, serverView(c.group.id).activeEpoch, 60_000);
    return {
      members: ['W1', 'W2', ...minted.filter((m) => m.enrolled).map((m) => m.device)],
      minted: Object.fromEntries(minted.map((m) => [m.device, m])),
      detail: { minted, seated, decisions: commitSequence(commitLines(c.group.id, c.startSince)) },
      judge: () => raceEnrolOwn({ minted, seated, ownerCaughtUpMs }),
    };
  },

  /** DEV-6: a message at the owner's arrival; W3 minted then revoked; W6 minted reads that message. */
  async 'DEV-6'(c) {
    const mark = rowMessageMark(id, 'EARLY');
    await send(seats.seat.W1.cx, `${id} at the owner's arrival [${mark}]`);
    const first = await mintOn('W3');
    if (!first.enrolled) return { premise: [`W3 did not enrol: ${first.refused ?? 'not enrolled'}`], detail: { first } };
    const firstSeatedMs = await seatActiveWithin(c.group.id, first.deviceId, 120_000);
    const panel = revokeFrom('W1', first.deviceId);
    const goneMs = await seatGoneWithin(c.group.id, first.deviceId, 120_000);
    const second = await mintOn('W6');
    if (!second.enrolled) return { premise: [`W6 did not enrol: ${second.refused ?? 'not enrolled'}`], detail: { first, second } };
    const read = await readsOn('W6', c, mark);
    return {
      members: ['W1', 'W6'],
      revoked: ['W3'],
      minted: { W3: first, W6: second },
      detail: { first, second, panel, goneMs, firstSeatedMs },
      judge: () => originalArrivalOwn({ firstSeatedMs, revoked: panel.ok && goneMs !== null, listed: read.listed, earlyShown: read.shown }),
    };
  },

  /** DEV-7: W3's base read fails; A1, swiped away, is the only member device left to answer it. */
  async 'DEV-7'(c) {
    const A1 = seats.seat.A1;
    const W1 = seats.seat.W1;
    const a1Device = await deviceIdOf(A1.cx, c.user.A1);
    if (!a1Device || (await seatActiveWithin(c.group.id, a1Device, 90_000)) === null) return { premise: ['A1 holds no active seat in the group'], detail: {} };
    // OUR OWN CONNECTION, ARMED BEFORE THE MINT: the wipe navigates the page and the interception stays.
    const f3 = await armFault(seats.seat.W3.cx, [{ match: `/api/mls/group-info/${c.group.id}`, method: 'GET', fault: 'status 503' }]);
    const killed = { A1: await killSeat(A1, 'swipe') };
    let moved = null;
    if (variant === 'stale') {
      await armLeafRefresh(W1.cx, c.user.W1, await deviceIdOf(W1.cx, c.user.W1), c.group.id);
      const before = serverView(c.group.id).activeEpoch;
      await send(W1.cx, `${rowId} moves the group while A1 is shut [${rowMessageMark(id, 'STALE')}]`);
      moved = await awaitServer(c.group.id, (v) => v.activeEpoch > before, 60_000);
    }
    killed.W1 = await killSeat(W1, 'tab');
    killed.W2 = await killSeat(seats.seat.W2, 'tab');
    const sinceMs = Date.now();
    const srvSince = now();
    const mintP = mintOn('W3');
    let opened = null;
    if (variant === 'opened') {
      // INSIDE THE ROUND TRIP: launched the moment the phone says it staged, before its answer.
      const stagedMs = await within(async () => (await logcatSince(sinceMs)).some((l) => l.includes('Welcome staged')), spec.answerBoundMs, 500);
      opened = stagedMs === null ? { never: 'no Welcome staged line' } : await reviveSeat(A1, 'swipe', `${rowId}:A1`);
    }
    const minted = await mintP;
    const answeredMs = await within(async () => bgAnswered(await logcatSince(sinceMs)), spec.answerBoundMs, 2_000);
    const phone = await logcatSince(sinceMs);
    await sleep(variant === 'opened' ? 20_000 : 0);
    const webview = variant === 'opened' && !opened?.never ? consoleLines(A1.cx) : [];
    const server = bgWelcomeTrace(srvLines('chat-delivery-service', srvSince), c.group.id);
    const records = { W3: (await f3.disarm()).records };
    // THE WORLD COMES BACK, so the newcomer is read and the invariant has members.
    const revived = {};
    if (!opened || opened.never) revived.A1 = await reviveSeat(A1, 'swipe', `${rowId}:A1`);
    revived.W1 = await reviveSeat(W1, 'tab', `${rowId}:W1`);
    revived.W2 = await reviveSeat(seats.seat.W2, 'tab', `${rowId}:W2`);
    await openGroup(W1.cx, c.group.name, { label: rowId });
    const mark = rowMessageMark(id, 'NEXT');
    await send(W1.cx, `${rowId} the next message [${mark}]`);
    const read = await readsOn('W3', c, mark);
    return {
      members: ['A1', 'W1', 'W2', 'W3'],
      offline: ['A1', 'W1', 'W2'],
      minted: { W3: minted },
      records,
      detail: { variant, minted, killed, moved: moved?.activeEpoch ?? null, opened, answeredMs, revived, phoneLines: phone.length, server, expected: BG_WELCOME[variant] },
      judge: () => [{ what: `the phone ended its background answer (${answeredMs === null ? 'never' : `${answeredMs} ms`})`, ok: answeredMs !== null }, ...bgWelcomeOwn(variant, { phone, webview, server, newcomerRead: read.shown })],
    };
  },

  /** DUP-7: W1 invites W4; the Add loses its answer, its Welcome send is held, failed, and W1 reloads. */
  async 'DUP-7'(c) {
    const W1 = seats.seat.W1;
    const W4 = seats.seat.W4;
    const inGroup = `"groupId":"${c.group.id}"`;
    const f = await armFault(W1.cx, [
      { ...COMMIT_POST, bodyIncludes: inGroup, fault: 'lose-answer once' },
      { match: '/api/mls/welcome', method: 'POST', bodyIncludes: inGroup, fault: 'hold once' },
    ]);
    // THE PRODUCT'S INVITE PATH, from the group W1 has open: the picker, the pick, the button.
    let invited = true;
    try {
      await addMembers(W1.cx, [displayNameOf(c.user.W4)]);
    } catch (e) {
      invited = false;
      console.log(`[${rowId}] W1's invite of W4 did not go through the picker: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    let heldWelcome = false;
    let reloaded = false;
    try {
      await f.awaitHeld(1, 240_000);
      heldWelcome = true;
    } catch (e) {
      console.log(`[${rowId}] the Welcome send was never held: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    if (heldWelcome) {
      // BETWEEN THE MERGE AND THE WELCOME: the send dies with the document, and the reload owes it.
      await f.fail();
      await reloadAndWait(W1.cx);
      reloaded = (await unlockClient(W1.cx, W1.target.port, W1.target.account, { match: APP_TAB })).verdict === 'unlocked';
    }
    const disarmed = await f.disarm();
    const records = { W1: disarmed.records };
    const unmet = [...(invited ? [] : ["W1's invite of W4 never went through the picker"]), ...addAcrossReloadPremise({ vacuous: disarmed.vacuous })];
    if (unmet.length) return { premise: unmet, members: ['W1', 'W2'], records, detail: { invited, vacuous: disarmed.vacuous } };
    const listed = (await awaitListed(W4.cx, c.group.name, 120_000)) !== null;
    // A SECOND COPY, IF ONE COMES, comes from the reloaded W1's settlement: given the same bound.
    await sleep(15_000);
    const welcome = welcomeLines(consoleLines(W4.cx), c.group.id);
    // HOW W4 GOT IN WHEN NO WELCOME CAME (alpha.3, 2026-10-25): its own repair, an external join. Recorded,
    // never counted as the Welcome the row asks about - a heal is the evidence the primary path failed.
    const selfRejoined = consoleLines(W4.cx).some((l) => l.includes(`[READD] ${c.group.id.slice(0, 8)}... rejoined via external commit`));
    const seq = commitSequence(commitLinesBy(commitLines(c.group.id, c.startSince), c.user.W1));
    return {
      members: ['W1', 'W2', 'W4'],
      records,
      narration: dup7Narration(c.group.id),
      detail: { invited, heldWelcome, reloaded, welcome, decisions: seq, selfRejoined },
      judge: () => welcomeAcrossReloadOwn({ seq, heldWelcome, reloaded, welcome, listed }),
    };
  },
};
ACTIONS['DEV-2'] = ACTIONS.revoke;
ACTIONS['DEV-3'] = ACTIONS.revoke;

/** Set up, act, judge. */
async function play() {
  const user = Object.fromEntries([...spec.devices, ...spec.mint].map((d) => [d, userOf(seats, d)]));
  const cx = (d) => seats.seat[d].cx;
  const owner = 'W1';
  // A seat the ROW adds (`addedInRow`, DUP-7's invitee) is left out of the setup entirely.
  const inRow = new Set(spec.addedInRow ?? []);
  const setUp = spec.devices.filter((d) => !inRow.has(d));
  const peers = setUp.filter((d) => d !== owner && user[d] !== user[owner]);
  const group = await mintRowGroup(cx(owner), id, user[owner]);
  assertRowOwns({ kind: 'group', id: group.id, name: group.name }, id);
  await openGroup(cx(owner), group.name, { navigate: false, label: rowId });
  if (peers.length) {
    await addMembers(cx(owner), peers.map((d) => displayNameOf(user[d])));
    await closeOverlays(cx(owner));
  }
  const premise = [];
  for (const d of setUp.filter((d) => d !== owner)) if ((await awaitListed(cx(d), group.name, 90_000)) === null) premise.push(`${d} never listed ${group.name}`);
  if (premise.length) return { premise, detail: { group: group.id } };
  for (const d of setUp) await openGroup(cx(d), group.name, { navigate: false, label: rowId });

  const fromEpoch = serverView(group.id).activeEpoch;
  const c = { user, group, startSince: now() };
  const act = await ACTIONS[id](c);
  if (act.premise?.length) return { premise: act.premise, detail: { group: group.id, ...act.detail } };

  // THE INVARIANT RUNS OVER THE MEMBERS: a revoked device holds nothing, and its page is a sign-in.
  const kept = new Set(act.members);
  const invariant = await checkInvariant({
    group: group.id,
    targets: seats.targets.filter((t) => kept.has(t.device)),
    members: act.members,
    conversation: group.name,
    fromEpoch,
    since,
    reload: true,
    watchers: watchersOf(seats),
  });
  return {
    own: act.judge(),
    invariant,
    act,
    detail: { group: group.id, name: group.name, fromEpoch, ...act.detail, ...(spec.note ? { note: spec.note } : {}) },
  };
}

try {
  seats = await openSeats([...spec.devices, ...spec.mint], rowId);
  const out = await play();
  const { verdict, failures } = composeVerdict({ own: out.own ?? [], invariant: out.invariant ?? null, premise: out.premise ?? [] });
  for (const f of failures) console.log(`[${rowId}] ${f}`);
  console.log(`[${rowId}] assertions: ${verdict}`);
  const act = out.act ?? {};
  // A ROW THAT MINTS tells the owner (W1) and every contact (W2) of the new device - the subject of
  // DEV-1 and the premise of every other DEV row, so both seats name their device-notice narration.
  const minting = spec.mint.length > 0;
  // THE MINTED IDS, per seat: the owner vets each one (`[TRUST] ... vetted: pinned`, DEV-2 of alpha.6),
  // and a minted seat vets its sibling - scoped to these ids, never forgiven by tag.
  const mintedIds = Object.fromEntries(Object.entries(act.minted ?? {}).filter(([, m]) => m?.deviceId).map(([d, m]) => [d, m.deviceId]));
  const logs = {
    W1: [
      ...GROUP_CREATION_NARRATION,
      ...(act.revoked?.length ? DEVICE_PANEL_NARRATION : []),
      ...(minting ? [...OWNER_DEVICE_NOTICE_NARRATION, ...mintedKeyPackageVettedNarration(Object.values(mintedIds))] : []),
      ...(act.narration ?? []),
    ],
    ...(minting && spec.devices.includes('W2') ? { W2: CONTACT_DEVICE_NOTICE_NARRATION } : {}),
  };
  const refusals = {};
  for (const d of spec.mint) {
    // The single logout line is forgiven on a revoked seat ONLY while the live console holds exactly one.
    // `seats.seat[d].cx`, not `cx(d)`: that helper is local to `play()`, and the judge runs out here
    // (#2523 wrote `cx(d)`, and DEV-2's first alpha.6 run died on `cx is not defined`).
    logs[d] = (act.revoked ?? []).includes(d) ? [...REVOKED_NARRATION, revokedLogoutOnce(() => consoleLines(seats.seat[d].cx))] : MINT_NARRATION;
    // TWO MINTS IN ONE ROW (DEV-4, DEV-6) make each minted seat the owner's other device for the
    // other: it is told of its sibling at first sight and vets the sibling's KeyPackage.
    if (spec.mint.length > 1) {
      const siblings = Object.entries(mintedIds)
        .filter(([s]) => s !== d)
        .map(([, id]) => id);
      logs[d] = [...logs[d], ...OWNER_DEVICE_NOTICE_NARRATION, ...mintedKeyPackageVettedNarration(siblings)];
    }
    refusals[d] = (act.revoked ?? []).includes(d) ? [...MINT_REFUSALS, ...REVOKED_REFUSALS] : MINT_REFUSALS;
  }
  const observers = await observersOf(seats, { logs, refusals, provoked: act.records ?? {}, offline: act.offline ?? [] });
  await finishObserved(
    rowId,
    verdict,
    { ...out.detail, own: out.own ?? [], failures, invariant: invariantDetail(out.invariant ?? null), serverWindowSince: since },
    observers,
    async () => {
      // THE NOTICES THIS ROW'S MINTS LEFT, dismissed after the verdict and only for the ids it minted:
      // on W1 every one, on a minted seat still signed in its siblings (`devicenotice.mjs`).
      const ids = Object.values(mintedIds);
      await dismissMintedNoticesOn([
        { seat: 'W1', cx: seats.seat.W1?.cx, minted: ids },
        ...Object.entries(mintedIds)
          .filter(([d]) => !(act.revoked ?? []).includes(d))
          .map(([d, id]) => ({ seat: d, cx: seats.seat[d]?.cx, minted: ids.filter((x) => x !== id) })),
      ]);
      closeSeats(seats);
    }
  );
} catch (e) {
  console.error(`[${rowId}] ${e?.stack ?? e}`);
  record(rowId, 'ERROR', errorDetail(e));
  closeSeats(seats);
  process.exit(1);
}

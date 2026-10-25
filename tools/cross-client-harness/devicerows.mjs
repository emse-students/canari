/**
 * THE DEVICE ROWS OF THE 1.4.1 CAMPAIGN - DEV-1..4, DEV-6, DEV-7 and DUP-7 - their table and judges.
 *
 * Pure, so `archive/devrows-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/devrows.mjs`. `docs/wiki/cross-client-campaign-1-4-1.md` section 4.2 is the plan. Every row
 * mints a device the server has never seen (`newdevice.mjs`, through `archive/mintdevice.mjs` so two
 * can race) on a WIPEABLE seat of the owner, and asks what the group does about it: seat it, revoke
 * it online or offline, admit two at once, keep the owner's arrival after a revoke, answer it from a
 * phone in the background, deliver its Welcome once across a lost answer and a reload.
 */

/** DEV-5 is played with CORRUPT-8, not on this build (owner decision, 2026-10-25). */
export const DEV5_ELSEWHERE = 'DEV-5 (one device id presenting a new signature key) is attached to CORRUPT-8 and played later, not on this build';

/** The rows `archive/devrows.mjs` plays. */
export const DEV_ROWS = {
  'DEV-1': {
    devices: ['W1', 'W2'],
    mint: ['W3'],
    what: "a new device of the owner (W3) is seated automatically; the owner's notice shows once, and the group's device line once on the contact (W2), never on the owner",
  },
  'DEV-2': {
    devices: ['W1', 'W2'],
    mint: ['W3'],
    revoke: 'online',
    seatBoundMs: 120_000,
    what: "W1 revokes W3 while it is online: W3's seat goes from the group, W3 is told and reset, the group carries on",
  },
  'DEV-3': {
    devices: ['W1', 'W2'],
    mint: ['W3'],
    revoke: 'offline',
    seatBoundMs: 120_000,
    what: 'W1 revokes W3 while it is cut off: the seat goes anyway, and on its return W3 holds nothing',
  },
  'DEV-4': {
    devices: ['W1', 'W2'],
    mint: ['W3', 'W6'],
    together: true,
    seatBoundMs: 180_000,
    what: 'two fresh devices of the owner enrol at the same instant: both seated, one tree, no add-lock deadlock',
  },
  'DEV-6': {
    devices: ['W1'],
    mint: ['W3', 'W6'],
    revokeFirst: 'W3',
    what: "after one device (W3) is revoked, a new one (W6) still reads from the owner's ORIGINAL arrival (#2254)",
  },
  'DEV-7': {
    devices: ['A1', 'W1', 'W2'],
    mint: ['W3'],
    variants: ['cold', 'opened', 'stale'],
    answerBoundMs: 180_000,
    what: "the background Welcome on A1: W3's external join fails (503 on its group-info read), its welcome_request is answered by the phone in the background - cold, opened inside the round trip, or stale",
    note:
      "A1 is SWIPED away (killed, not force-stopped: a force-stopped app receives no push), then W1's and W2's tabs are closed, so A1 is the only member device left to answer. " +
      "`stale` moves the group once (a leaf refresh by W1) between the swipe and the closing. The lines are the backlog's own (Hardware reading owed: one background Welcome on the Mi 9T)",
  },
  'DUP-7': {
    devices: ['W1', 'W2'],
    mint: ['W3'],
    what: "W1's automatic Add of W3 is accepted only through a resubmission (answer lost), and W1 reloads between the merge and the Welcome send: W3 receives ONE Welcome",
  },
};

/** What each DEV-7 variant must print, on the phone and on the server, and what it must not. */
export const BG_WELCOME = {
  cold: {
    phone: ['Welcome staged', 'Welcome sent - staged Add merged'],
    forbidden: ['REFUSED', 'OUTCOME UNKNOWN', 'ACCEPTED AND NOT HELD'],
    server: ['[BG_WELCOME]', 'commit accepted -> activeEpoch=', 'DONE'],
  },
  opened: {
    phoneAnyOf: ['stage left in mls.bin (left-to-foreground)', 'already settled by the foreground'],
    webview: ['[COMMIT] settling 1 staged commit(s) by resubmission', 'accepted - merged'],
    forbidden: ['ACCEPTED AND NOT HELD', 'is ABSENT from the state this foreground keeps', 'ERASES'],
    // NOTHING REQUIRED OF THE BACKGROUND ROUTE: a stage left to the foreground is settled through the
    // ordinary commit route, so whether `[BG_WELCOME]` ever ran depends on when the app opened.
    server: [],
  },
  stale: {
    phone: ['REFUSED epoch_mismatch'],
    forbidden: ['ACCEPTED AND NOT HELD'],
    server: ['[BG_WELCOME]'],
  },
};

const has = (lines, needle) => lines.some((l) => l.includes(needle));
const ms = (v) => (v === null || v === undefined ? 'never' : `${v} ms`);

/**
 * One device's seat in the server's view (`serverView` `seats`): `active`, the stored status
 * otherwise, `kicked`, or `absent` - a revoked device's seat is GONE when it is anything but active.
 */
export function deviceSeat(view, deviceId) {
  const s = (view?.seats ?? []).find((x) => x.deviceId === deviceId);
  if (!s) return 'absent';
  if (s.kicked) return 'kicked';
  return s.status;
}

/**
 * The chat-delivery `[BG_WELCOME]` lines of ONE group: its START lines name the group, every later
 * line only the trace, so the traces are read off the STARTs and the rest is matched by trace.
 */
export function bgWelcomeTrace(lines, groupId) {
  const traces = new Set();
  for (const l of lines ?? []) {
    const m = /\[BG_WELCOME\]\[([^\]]+)\] START group=(\S+)/.exec(l);
    if (m && m[2] === groupId) traces.add(m[1]);
  }
  return (lines ?? []).filter((l) => [...traces].some((t) => l.includes(`[BG_WELCOME][${t}]`)));
}

/**
 * How many times a notice APPEARED in a series of on-screen counts sampled over time: each rise from
 * zero is one appearance, and the highest count says whether two were ever shown at once.
 */
export function appearances(samples) {
  let shown = 0;
  let prev = 0;
  for (const n of samples) {
    if (n > 0 && prev === 0) shown += 1;
    prev = n;
  }
  return { shown, most: samples.length ? Math.max(...samples) : 0 };
}

/** The phone lines that END a background answer, whichever way it went (backlog, the Mi 9T reading). */
export const BG_ANSWER_ENDS = ['Welcome sent - staged Add merged', 'REFUSED epoch_mismatch', 'OUTCOME UNKNOWN', 'ACCEPTED AND NOT HELD', 'left-to-foreground', 'already settled by the foreground'];

/** Whether the phone has logged the end of its background answer - the row's wait, never a sleep. */
export const bgAnswered = (lines) => (lines ?? []).some((l) => BG_ANSWER_ENDS.some((n) => l.includes(n)));

/** The `MINTED {json}` line `archive/mintdevice.mjs` ends with, parsed; null when there is none. */
export function mintedLine(stdout) {
  const line = String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('MINTED '))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line.slice('MINTED '.length));
  } catch {
    return null;
  }
}

/**
 * DEV-1: seated automatically; the owner's notice once; in the row's group, the device line once on
 * the CONTACT (W2) and never on the OWNER (W1).
 *
 * The owner is told by the account notice and gets no line (`deviceEventAudience`: own account ->
 * `owner-alert`). A contact gets the line in every 1:1 and group it shares with the owner, so `lines`
 * is counted in the open conversation's pane only (`chat.mjs` `paneOccurrences`): counted on the whole
 * page it read eight on W2 on 2026-10-25, one per shared conversation's preview, all correct.
 *
 * @param {{seatedMs: number|null, notice: {shown: number, most: number}, lines: {W1: number, W2: number}}} p
 */
export function deviceAddedOwn({ seatedMs, notice, lines }) {
  return [
    { what: `the new device was seated in the group automatically (${ms(seatedMs)})`, ok: seatedMs !== null },
    { what: `the owner's new-device notice appeared once, never two at a time (${notice.shown} appearance(s), at most ${notice.most})`, ok: notice.shown === 1 && notice.most === 1 },
    { what: `W2 (a contact) shows the "added a device" line once in the group (${lines.W2})`, ok: lines.W2 === 1 },
    { what: `W1 (the owner) shows no "added a device" line in the group - the notice is its alert (${lines.W1})`, ok: lines.W1 === 0 },
  ];
}

/** DEV-2: the seat goes, the device is told, and it cannot read the group any more. */
export function revokedOwn({ seatGoneMs, toldMs, listedAfter }) {
  return [
    { what: `the revoked device's seat left the group (${ms(seatGoneMs)})`, ok: seatGoneMs !== null },
    { what: `the revoked device was told and reset, or signed out (${ms(toldMs)})`, ok: toldMs !== null },
    { what: `the revoked device no longer lists the group (${listedAfter ? 'STILL LISTED' : 'gone'})`, ok: !listedAfter },
  ];
}

/** DEV-3: the seat went while the device was away; on return it holds nothing. */
export function offlineRevokeOwn({ seatGoneMs, toldMs, listedAfter, cutHeld }) {
  return [
    { what: `the device was cut off throughout the revoke (${cutHeld ? 'cut' : 'NOT cut'})`, ok: cutHeld },
    ...revokedOwn({ seatGoneMs, toldMs, listedAfter }).map((a) => ({ ...a, what: a.what.replace('the revoked device', 'the returning device') })),
  ];
}

/** DEV-4: both enrolled, both seated, the owner's tree at the server's epoch. */
export function raceEnrolOwn({ minted, seated, ownerCaughtUpMs }) {
  return [
    ...minted.map((m) => ({ what: `${m.device} enrolled (${m.enrolled ? 'yes' : m.refused ?? 'no'})`, ok: m.enrolled === true })),
    ...Object.entries(seated).map(([d, v]) => ({ what: `${d} seated in the group (${ms(v)})`, ok: v !== null })),
    { what: `one tree: W1 at the server's epoch (${ms(ownerCaughtUpMs)})`, ok: ownerCaughtUpMs !== null },
  ];
}

/** DEV-6: the new device lists the group and reads what was written before the revoked one existed. */
export function originalArrivalOwn({ revoked, listed, earlyShown }) {
  return [
    { what: `the first device was revoked (${revoked ? 'yes' : 'no'})`, ok: revoked },
    { what: `the new device lists the group (${listed ? 'listed' : 'NOT listed'})`, ok: listed },
    { what: `it reads the message written at the owner's ORIGINAL arrival (${earlyShown})`, ok: earlyShown === 1 },
  ];
}

/** DEV-7: the variant's lines, present and absent, on the phone, its WebView and the server. */
export function bgWelcomeOwn(variant, { phone, webview = [], server, newcomerRead }) {
  const want = BG_WELCOME[variant];
  if (!want) return [{ what: `no variant named ${variant}`, ok: false }];
  const out = [];
  for (const n of want.phone ?? []) out.push({ what: `the phone logs "${n}"`, ok: has(phone, n) });
  if (want.phoneAnyOf) out.push({ what: `the phone logs one of ${want.phoneAnyOf.map((n) => `"${n}"`).join(' / ')}`, ok: want.phoneAnyOf.some((n) => has(phone, n)) });
  for (const n of want.webview ?? []) out.push({ what: `the WebView logs "${n}"`, ok: has(webview, n) });
  for (const n of want.forbidden) out.push({ what: `nothing logs "${n}"`, ok: !has(phone, n) && !has(webview, n) });
  for (const n of want.server) out.push({ what: `the server logs "${n}"`, ok: has(server, n) });
  if (variant !== 'stale') out.push({ what: 'no REJECT on the server for the group', ok: !server.some((l) => /\bREJECT\b/.test(l)) });
  out.push({ what: `the newcomer reads the group's next message (${newcomerRead})`, ok: newcomerRead === 1 });
  return out;
}

/** DUP-7: the Add settled by resubmission, the Welcome held across a reload, and ONE join. */
export function welcomeAcrossReloadOwn({ seq, heldWelcome, reloaded, welcome, listed }) {
  const accepts = seq.filter((d) => d.kind === 'ACCEPT').length;
  const duplicates = seq.filter((d) => d.kind === 'DUPLICATE').length;
  return [
    { what: `the Add was accepted once and answered again on resubmission (${accepts} accept, ${duplicates} duplicate)`, ok: accepts === 1 && duplicates >= 1 },
    { what: `the Welcome request was held when the page reloaded (${heldWelcome ? 'held' : 'NOT held'}, ${reloaded ? 'reloaded' : 'NOT reloaded'})`, ok: heldWelcome && reloaded },
    { what: `the new device joined ONCE (${welcome.joined} join line(s), ${welcome.redelivered} redelivery)`, ok: welcome.joined === 1 },
    { what: `no second copy was processed as a join (${welcome.failed.length} failure line(s))`, ok: welcome.failed.length === 0 },
    { what: `the new device lists the group (${listed ? 'listed' : 'NOT listed'})`, ok: listed },
  ];
}

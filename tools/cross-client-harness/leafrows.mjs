/**
 * THE LEAF-REFRESH ROWS - LEAF-REFRESH-1, -2 and -4 - their table and their judges, pure.
 *
 * The rows are the plan's own ([cross-client-testing-archive-1-4-0](../../docs/wiki/cross-client-testing-archive-1-4-0.md)):
 * the periodic leaf refresh (`leafRefresh.ts`) stages a self-update commit when a durable send finds
 * the device's own leaf older than seven days, and `runCommitTransaction` checkpoints that stage to
 * disk BEFORE its first request leaves (`checkpointStageBeforeSend`, #2269). The three rows put a
 * fault at the three places that guarantee matters: the link, the process, and the roster.
 *
 *  - LEAF-REFRESH-1: the link is CUT while the due refresh is being submitted, then the owner sends.
 *  - LEAF-REFRESH-2: the page is RELOADED while the refresh's commit POST is held.
 *  - LEAF-REFRESH-4: a device of the peer is REVOKED, and the owner's next connection removes its leaf.
 *
 * (-3, a refresh with a member offline, has no fault to arm: it was read by hand on 2026-11-16.)
 *
 * Pure, so `archive/leaf-selftest.mjs` pins every judge on a checkout with no rig; the action is
 * `archive/leaf.mjs`. Nothing here reads a clock: every assertion is a comparison of logged state -
 * the gate's own `[COMMIT]` lines in order (`settlerows.mjs` `commitSequence`), the client's own
 * console narration, the leaf ledger, and what a reader's pane showed while the commit was unknown.
 *
 * WHICH SEATS: the rig's three spare Chrome profiles. `owner` is W6 (alpha), `peer` is W7 (beta); W1 to
 * W5 belong to the other rows and other sittings and are never opened here.
 */
import { decidedAfter, firedAtLeast, resubmissionLine } from './settlerows.mjs';
import { AUTH_TEARDOWN_NARRATION, DELIVERY_CROSSING_NARRATION, OVERLAY_STACK_NARRATION, REVOKED_REFUSALS, atLevels } from './watch.mjs';

/**
 * The rows. `devices` is what `openSeats` opens, the first being the OWNER (the committer: the one
 * whose leaf is refreshed, and who removes a revoked leaf). `cut` means the row takes the owner off
 * the network (`net.mjs` `armCut` at the start, `cutHard` in the row).
 */
export const LEAF_ROWS = {
  'LEAF-REFRESH-1': {
    devices: ['W6', 'W7'],
    cut: true,
    side: true,
    what: 'the link is cut while a due refresh is submitted: the commit is kept unknown, no send leaves into the group until a resubmission answers, then the queued messages arrive once',
    note: 'the first request is held BEFORE the server and failed, so it never left: the resubmission after the return is ACCEPTED, and the lost-answer shape (DUPLICATE) is DUP-1 / OFF-2',
  },
  'LEAF-REFRESH-2': {
    devices: ['W6', 'W7'],
    cut: false,
    what: 'the page is reloaded while the refresh commit is held: the stage and its record come back from disk, the settlement merges it once, and the ledger names the epoch the server holds',
  },
  'LEAF-REFRESH-4': {
    devices: ['W6', 'W7'],
    cut: false,
    revokes: 'W7',
    what: "a device of the peer is revoked: at the owner's next connection its leaf leaves every conversation the owner holds, and a commit attempted from the revoked device is refused DEVICE_REVOKED",
    note: "the revoked device is W7's own (a campaign-owned device minted by newdevice.mjs); W7 wipes itself on the revocation and is re-enrolled by hand afterwards",
  },
};

/**
 * WHAT A LEAF-REFRESH ROW'S TWO BROWSER SEATS SAY WHILE IT MINTS A GROUP, ADDS THE PEER AND REOPENS
 * ITS PAGES - given to BOTH seats of these rows and nowhere else.
 *
 * Read on LEAF-REFRESH-1, -2 and -4 against `dev.9ca790c` (2026-11-16), `PASS-DIRTY` on them. Every
 * line is a decision the coding standard asks the app to log, said by the flow the row IS: opening
 * the panels that mint and fill a group (the overlay stack), delivering one Welcome per device of the
 * peer (`join push ->`, one per device, so a push is a per-device act and not a repeat), the peer's
 * pending-invitation sync finding each of those devices already in the tree and vouching, a group
 * view settling and asking once for the history of a short thread, and a reload booting the page
 * again (the ledgers opened, the nicknames restated, the keyboard baseline, one reason per community
 * for a history that is not asked or waits for a device: the bench accounts' other devices are
 * offline by construction). A seat in front of the screen and idle asks for the notification
 * permission once per inbound text (`permission is "default"`: the rig's profiles never granted it).
 *
 * THE SENTENCES ARE PINNED, AND ONLY THE HAPPY SPELLINGS: `join push -> ... NOT DELIVERED`, a
 * `[GRAINE]` line that names a refusal or a removal, a `[PENDING]` line that is not the vouching one,
 * and every `warn`/`error` of the same tags are not matched and stay dirt. No outcome of the refresh
 * itself is forgiven here: the commit, the resubmission and the ledger are asserted by the judges.
 */
export const LEAF_ROW_NARRATION = [
  ...OVERLAY_STACK_NARRATION,
  // A reload meets the delivery crossing's ONE sentence per session (the socket and the pull both hand a row in); a live frame for an acknowledged row, which accuses the server, is not matched.
  ...DELIVERY_CROSSING_NARRATION,
  atLevels(['debug'], /^\[chat\.entry\] short thread: asking for older history \(window \d+\)$/),
  atLevels(['debug'], /^\[ChatArea\] (?:older-history load|peer scrollback answer \(asked\)) retired by a conversation switch$/),
  atLevels(['debug'], /^\[keyboardViewport\] baseline \d+ -> \d+ \(settled\)$/),
  atLevels(['debug'], /^\[NICKNAME\] \d+ salon placement\(s\) changed$/),
  atLevels(['info'], /^\[NICKNAME\] \d+ nickname\(s\) of \d+ conversation\(s\) restated for the notifications$/),
  atLevels(['info'], /^\[CHAT_VIEW\] [0-9a-f]{8} entry settled: pinned=(?:true|false) isNearBottom=(?:true|false) newestVisible=(?:true|false) rows=\d+ fromBottom=\d+$/),
  atLevels(['info'], /^\[GRAINE\] the history of community [0-9a-f]{8} is not asked: no other member, and none of our other devices on its key group is online to receive the request$/),
  atLevels(['info'], /^\[GRAINE\] the history of community [0-9a-f]{8} waits for a device: \d+ member\(s\) answered "I hold nothing" from every device online, and each has another device on the key group, offline - asked at the next start$/),
  atLevels(['log'], /^\[JOIN_PUSH\] [0-9a-f]{8}\.\.\. join push -> [0-9a-f]{8}…:\S+ \(addressable when its Welcome was answered\)$/),
  atLevels(['debug'], /^\[TRUST\] KeyPackage for \S+ vetted: pinned$/),
  atLevels(['log'], /^\[LEDGER\] opened the ledgers the MLS state carries for [0-9a-f]{8}\.\.\. - \d+ key\(s\)$/),
  atLevels(['log'], /^\[PENDING\] \S+ already in tree for [0-9a-f]{8}… - invitation fulfilled, vouching$/),
  // THE PEER'S SWEEP MEETING THE OWNER'S ADD LOCK: the Add that seats the peer holds the group's add lock, the peer's
  // pending-invitation sweep finds it taken, skips and continues (`acquired=false` is the lock doing its job, srvlog.mjs).
  atLevels(['log'], /^\[PENDING\] Group [0-9a-f]{8}…: lock held by another device - skip, its asks stay as shown$/),
  atLevels(['log'], /^\[NOTIF\] Inbound in [0-9a-f]{8}… while the window is in front but idle \(no gesture for \d+ s\) - asking\.$/),
  atLevels(['log'], /^\[NOTIF\] Not raised for [0-9a-f]{8}… - permission is "default"; asking\.$/),
  // A history request of another member that NAMES one of the owner's OTHER devices (its phone): the web seat reads it,
  // sees it is not the addressee and says why it does not answer. Said only when the peer asks while W6 is up.
  atLevels(['debug'], /^\[GRAINE\] not answering [0-9a-f]{8}…'s request [0-9a-f]{8}… in community [0-9a-f]{8}: it names \S+, not this device - the requester saw it offline or outside the key group's tree$/),
];

/**
 * WHAT THE REVOKED SEAT OF LEAF-REFRESH-4 SAYS WHILE IT ERASES ITSELF, beside `REVOKED_SIGN_OUT_NARRATION`.
 *
 * W7's own device is revoked while its page stays open, so its page runs `wipeRevokedDevice`: the
 * auth store clears and drops its socket (`AUTH_TEARDOWN_NARRATION`), the composer, the form drafts,
 * the local copies, the peer directory and the tab-commit store close (their databases are being
 * deleted, "no key in hand"), the publish queue stops, the avatar token is cleared and the router
 * replaces the entry it stood on with the origin it kept. Each is a step of the wipe.
 * `[RESET] ... SURVIVED the wipe` and
 * `could not clear` are in no list and stay dirt. Given to the revoked seat of -4 and no other.
 */
export const LEAF_REVOKED_WIPE_NARRATION = [
  ...AUTH_TEARDOWN_NARRATION,
  atLevels(['log', 'info'], /^\[COMPOSER\] signed out: staging of \d+, replies of \d+ and drafts of \d+ conversation\(s\) forgotten$/),
  atLevels(['log', 'info'], /^\[FORM-DRAFT-COPY\] store closed: the database is being deleted$/),
  atLevels(['log', 'info'], /^\[LOCAL-COPIES\] no key in hand - copies closed$/),
  atLevels(['log', 'info'], /^\[PEER-NAMES\] (?:no key in hand - directory closed|\d+ epoch\(s\) ended \(sign-out\))$/),
  atLevels(['log', 'info'], /^\[PUBLISH-QUEUE\] stopped$/),
  atLevels(['info'], /^\[TAB-COMMIT\] (?:store closed: the database is being deleted|drain \(this tab is unavailable\))$/),
  atLevels(['debug'], /^\[AvatarUrl\] avatar token cleared - avatar URLs unsigned$/),
  atLevels(['debug'], /^\[backToOrigin\] entry \S+ replaced: origin kept \(\/[a-z]*\)$/),
];

/**
 * THE REFUSALS THE REVOKED SEAT OF LEAF-REFRESH-4 IS TOLD TO PROVOKE: the revoked device's own reads
 * (`REVOKED_REFUSALS`) and the commit the row's page script attempts from it, refused 403
 * `DEVICE_REVOKED` - the row's own assertion, so the browser's echo of it is expected and necessary
 * there. Matched on the commit route and the 403 only; the same 403 on any other route, or on any
 * other row, is a finding.
 */
export const LEAF_REVOKED_REFUSALS = [...REVOKED_REFUSALS, { path: /^\/api\/mls\/commit$/, status: [403] }];

/** The needle of the client's own `unknown` verdict on a resubmission - the kept stage. */
export const unknownLine = (groupId, fromEpoch) => resubmissionLine(groupId, fromEpoch, 'unknown');

/** The needle of the client's own `accepted` verdict on a resubmission. */
export const acceptedLine = (groupId, fromEpoch) => resubmissionLine(groupId, fromEpoch, 'accepted');

/** The line the settlement writes when it takes staged commits back from the state on disk. */
export const SETTLING_LINE = /^\[COMMIT\] settling (\d+) staged commit\(s\) by resubmission$/;

/**
 * THE PREMISE OF EVERY REFRESH ROW: the owner's leaf in the row's group is one its OWN commit
 * produced (the setup Add), so the ledger can be backdated into a due refresh (`mlsrow.mjs`
 * `armLeafRefresh`). A leaf dated by the tree (a Welcome-only seat) cannot be armed.
 *
 * @param {object|null} entry the owner's ledger entry for the group, before arming
 * @returns {string[]} what is missing, empty when the premise holds
 */
export function refreshPremise(entry) {
  if (!entry) return ['the owner holds no ledger entry for the row group - its setup Add did not date its leaf'];
  if (entry.observed) return ['the owner\'s ledger entry is an OBSERVATION - its leaf is not one its own commit produced'];
  if (!entry.leaf) return ['the owner\'s ledger entry names no leaf - it describes none'];
  return [];
}

/**
 * THE SERVER'S ACCOUNT OF THE REFRESH: one commit, accepted once, moving the group by exactly one
 * epoch, never refused - a kept commit is settled, never rebuilt.
 *
 * @param {object} p
 * @param {number} p.fromEpoch the server's epoch before the refresh
 * @param {{activeEpoch: number, commitEpochs: number[]}} p.view `serverView` after the invariant
 * @param {{kind: string, newEpoch?: number, reason?: string}[]} p.seq `commitSequence` of the row's window
 * @param {number} [p.maxDuplicates] how many resubmissions the gate may have answered `duplicate`
 */
export function refreshLandedOnce({ fromEpoch, view, seq, maxDuplicates = 1 }) {
  const acc = seq.filter((d) => d.kind === 'ACCEPT');
  const dup = seq.filter((d) => d.kind === 'DUPLICATE').length;
  const rejects = seq.filter((d) => d.kind === 'REJECT').map((d) => d.reason);
  const moved = (view.commitEpochs ?? []).filter((e) => e >= fromEpoch);
  return [
    { what: `exactly one commit was accepted, never a second epoch for one refresh (${acc.length})`, ok: acc.length === 1 },
    { what: `it moved the group ${fromEpoch} -> ${fromEpoch + 1} (${acc[0]?.newEpoch ?? 'none'})`, ok: acc[0]?.newEpoch === fromEpoch + 1 },
    { what: `resubmissions answered duplicate: ${dup} (0..${maxDuplicates})`, ok: dup <= maxDuplicates },
    { what: `nothing was refused - a kept refresh is settled, never rebuilt (${rejects.join(',') || 'none'})`, ok: rejects.length === 0 },
    { what: `the server's active epoch moved by exactly one (${fromEpoch} -> ${view.activeEpoch})`, ok: view.activeEpoch === fromEpoch + 1 },
    { what: `the commit log holds exactly one row since ${fromEpoch} (${moved.join(',') || 'none'})`, ok: moved.length === 1 },
  ];
}

/**
 * THE LEDGER AFTER THE SETTLEMENT NAMES WHAT THE SERVER HOLDS: a REFRESH entry (not an observation),
 * for the epoch the accepted commit created, dated after the backdating, and for a leaf that is
 * not the one the refresh replaced.
 *
 * @param {{before: object|null, armed: object|null, after: object|null, serverEpoch: number}} p
 */
export function ledgerNamesServer({ before, armed, after, serverEpoch }) {
  return [
    { what: 'a ledger entry exists after the settlement', ok: !!after },
    { what: `it is a refresh, not an observation (${after?.observed ? 'observed' : 'refresh'})`, ok: !!after && !after.observed },
    { what: `it names the epoch the server holds (${after?.epoch ?? 'none'} vs ${serverEpoch})`, ok: after?.epoch === serverEpoch },
    { what: 'it is dated after the backdating, so the refresh rewrote it', ok: !!after && !!armed && after.at > armed.at },
    { what: 'it names a different leaf than before - the leaf was replaced', ok: !!after?.leaf && !!before?.leaf && after.leaf !== before.leaf },
  ];
}

/**
 * LEAF-REFRESH-1: while the commit was UNKNOWN and the link was back, the texts the owner had sent
 * in the row's group had NOT reached the peer - and the same link carried the owner's text in ANOTHER
 * group to the same peer (the control), so the absence is not an outage. After the settlement, every
 * one of the owner's texts arrived once.
 *
 * @param {object} p
 * @param {boolean} p.controlReached the owner's side-group text reached the peer while the commit was unknown
 * @param {number[]|null} p.blockedShown times each of the owner's row-group texts was shown on the peer during the window (null: not read)
 * @param {number[]} p.after times each of those texts is shown on the peer at the end
 */
export function sendsWaitForTheCommit({ controlReached, blockedShown, after }) {
  return [
    { what: "the owner's text in the side group reached the peer while the commit was unknown - the link was up", ok: controlReached },
    {
      what: `none of the owner's row-group texts had reached the peer by then (shown ${blockedShown ? blockedShown.join(',') : 'unread'})`,
      ok: controlReached && !!blockedShown && blockedShown.length > 0 && blockedShown.every((n) => n === 0),
    },
    { what: `every one of them arrived once after the settlement (${after.join(',') || 'none'})`, ok: after.length > 0 && after.every((n) => n === 1) },
  ];
}

/**
 * LEAF-REFRESH-1's own question, assembled: the stage was kept unknown while cut, the gateway came
 * back while the settlement was still answered with a transient refusal (the link up, the commit
 * unknown), the gate decided nothing for it before the second return (the first request never left),
 * and accepted it once the 503 was lifted, and the client said so.
 *
 * @param {object} p
 * @param {string|null} p.unknown the client's `unknown` line from the cut, or null
 * @param {number|null} p.gatewayMs the gateway's reconnection time after the first return, or null
 * @param {object[]} p.seqBefore the gate's decisions before the settlement was let through
 * @param {object[]} p.seqAfter the gate's decisions from the lifting of the 503 on
 * @param {string|null} p.settled the client's `accepted` line, or null
 * @param {object[]} p.heldRecords the first fault's records (the held request)
 * @param {object[]} p.unsentRecords the second fault's records (settlements answered 503 with the link up)
 */
export function cutDuringSubmit({ unknown, gatewayMs, seqBefore, seqAfter, settled, heldRecords, unsentRecords }) {
  return [
    firedAtLeast('hold (the due refresh submitted)', heldRecords, 1),
    { what: `the owner kept the stage unknown while cut (${unknown ?? 'no line in the window'})`, ok: !!unknown },
    { what: `the gateway reconnected after the cut (${gatewayMs ?? 'never'} ms)`, ok: gatewayMs !== null },
    firedAtLeast('status-unsent 503 (the settlement with the link up)', unsentRecords, 1),
    {
      what: `the gate decided nothing before the settlement was let through - the first request never left (${seqBefore.map((d) => d.kind).join(',') || 'nothing'})`,
      ok: seqBefore.length === 0,
    },
    decidedAfter('the 503 was lifted', seqAfter, 'ACCEPT'),
    { what: `the owner said its resubmission was accepted (${settled ?? 'no line in the window'})`, ok: !!settled },
  ];
}

/**
 * LEAF-REFRESH-2's own question: the page was reloaded with the commit POST held and nothing decided
 * by the gate; after the reload the settlement took the stage back from DISK (the settling line,
 * naming at least one staged commit), resubmitted, and was accepted.
 *
 * @param {object} p
 * @param {object[]} p.holdRecords the fault's records
 * @param {object[]} p.seqBeforeReload the gate's decisions when the reload was made
 * @param {string[]} p.settlingLines the owner's `settling N staged commit(s)` lines after the reload
 * @param {string|null} p.settled the client's `accepted` line, or null
 */
export function stageSurvivesReload({ holdRecords, seqBeforeReload, settlingLines, settled }) {
  const staged = settlingLines.map((l) => Number(SETTLING_LINE.exec(l)?.[1] ?? 0)).reduce((a, b) => a + b, 0);
  return [
    firedAtLeast('hold (the first request)', holdRecords, 1),
    { what: `the gate had decided nothing when the page was reloaded (${seqBeforeReload.map((d) => d.kind).join(',') || 'nothing'})`, ok: seqBeforeReload.length === 0 },
    { what: `after the reload the settlement took ${staged} staged commit(s) back from disk (1+ needed)`, ok: staged >= 1 },
    { what: `the owner said its resubmission was accepted (${settled ?? 'no line in the window'})`, ok: !!settled },
  ];
}

/** `[STRAY] <g8>... <n> revoked device(s) still hold a leaf - removing`: one per group a removal starts in. */
const STRAY_START = /^\[STRAY\] ([0-9a-f]{8})\.\.\. (\d+) revoked device\(s\) still hold a leaf - removing$/;
/** `[STRAY] <g8>... is now at epoch N - the revoked leaves are gone from the tree`: one per removal that landed. */
const STRAY_DONE = /^\[STRAY\] ([0-9a-f]{8})\.\.\. is now at epoch (\d+) - the revoked leaves are gone from the tree$/;

/** The needles a revocation row's owner narrates, anchored on each sentence - forgiven on the owner only. */
export const STRAY_NARRATION = [
  /^\[STRAY\] compared \d+ tree\(s\): \d+ roster\(s\) in one read, \d+ refused, \d+ not answered \(nobody removed in them\)$/,
  STRAY_START,
  STRAY_DONE,
];

/**
 * What the owner's removals of a revoked leaf did, read off its console: the groups a removal STARTED
 * in and the groups it FINISHED in, in order.
 *
 * @param {string[]} lines the owner's console lines, stamped or not (callers strip the stamp)
 * @returns {{started: {group: string, devices: number}[], finished: {group: string, epoch: number}[]}}
 */
export function strayRemovals(lines) {
  const started = [];
  const finished = [];
  for (const l of lines) {
    const s = STRAY_START.exec(l);
    if (s) started.push({ group: s[1], devices: Number(s[2]) });
    const f = STRAY_DONE.exec(l);
    if (f) finished.push({ group: f[1], epoch: Number(f[2]) });
  }
  return { started, finished };
}

/**
 * LEAF-REFRESH-4's own question: the revoked device's leaf left every conversation the owner holds -
 * ONE removal started per group (never two in a group), the row's group among them, every one that
 * started finished - and a commit attempted from the revoked device was refused `DEVICE_REVOKED`
 * (the answer AND the gate's own `REJECT device_revoked` line).
 *
 * @param {object} p
 * @param {ReturnType<typeof strayRemovals>} p.removals
 * @param {string} p.groupShort the row group's first eight characters
 * @param {{status: number|null, body?: string}} p.deleted the answer to the revocation
 * @param {{status: number|null, body?: string}} p.attempt the answer to the commit from the revoked device
 * @param {string[]} p.refusalLines the gate's `REJECT device_revoked` lines for the row's group and the device
 * @param {{deviceId: string, atEpoch: number}|null} p.rowCommit the row group's last commit-log row after the removal
 * @param {number} p.fromEpoch the row group's epoch before the removal
 * @param {string} p.ownerDevice the owner's device id
 * @param {number} p.serverEpoch the row group's epoch on the server at the end
 */
export function revokedLeafLeaves({ removals, groupShort, deleted, attempt, refusalLines, rowCommit, fromEpoch, ownerDevice, serverEpoch }) {
  const groups = removals.started.map((s) => s.group);
  const distinct = new Set(groups);
  const unfinished = [...distinct].filter((g) => !removals.finished.some((f) => f.group === g));
  return [
    { what: `the revocation was accepted (${deleted.status ?? 'transport failure'})`, ok: deleted.status !== null && deleted.status >= 200 && deleted.status < 300 },
    { what: `the owner started a removal in the row's group (${groups.includes(groupShort) ? groupShort : 'none'})`, ok: groups.includes(groupShort) },
    { what: `one removal per group, never two in one: ${groups.length} started in ${distinct.size} group(s)`, ok: groups.length === distinct.size },
    { what: `every removal that started finished (${unfinished.length ? `unfinished: ${unfinished.join(',')}` : 'all'})`, ok: unfinished.length === 0 },
    { what: `the row group moved ${fromEpoch} -> ${fromEpoch + 1} on the server (${serverEpoch})`, ok: serverEpoch === fromEpoch + 1 },
    { what: `the commit that moved it is the owner's own device (${rowCommit?.deviceId === ownerDevice ? 'the owner' : (rowCommit?.deviceId ?? 'none')})`, ok: !!rowCommit && rowCommit.deviceId === ownerDevice },
    { what: `a commit from the revoked device was refused 403 (${attempt.status ?? 'transport failure'})`, ok: attempt.status === 403 },
    { what: 'the refusal carries the code DEVICE_REVOKED', ok: /DEVICE_REVOKED/.test(attempt.body ?? '') },
    { what: `the gate logged the refusal for the row's group (${refusalLines.length} line(s))`, ok: refusalLines.length >= 1 },
  ];
}

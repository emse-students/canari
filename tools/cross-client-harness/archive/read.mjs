#!/usr/bin/env node
/**
 * READ-1..10 - MLS read receipts: the sidebar unread badge, and the sender's own
 * `.msg-status-sent` -> `.msg-status-read` transition.
 *
 * WHAT THE APP ACTUALLY PROMISES (read off the source, not guessed):
 *
 *   GATE   `MainChatPage.svelte`'s read-watermark $effect fires ONLY when
 *          `isWindowFocused && isTabVisible`, returns early on a selected CHANNEL (channels are
 *          server-authoritative, never send MLS receipts, and routing one through the MLS outbox
 *          loops on resolveTerminalGroup/welcome-request 500s), and returns early unless
 *          `convo.lifecycle === 'active'` (a conversation the peer deleted sends none). It computes
 *          ONE watermark (`watermarkAfterReading`), merges it optimistically at `setTimeout(...,0)`
 *          - onto disk as well as in memory - and flushes it ONCE after a 2000 ms debounce, via
 *          `sendReadWatermark`.
 *
 *          THE CARRIER IS A WATERMARK, NOT A LIST OF IDS, and this header said otherwise until
 *          2026-08-15. The history-reconciliation rework replaced per-message `readBy` with one
 *          timestamp per (conversation, user), COMPARED rather than accumulated - which is what
 *          stops a history catch-up marking a read message unread. The line numbers this block used
 *          to cite are deliberately gone: they were stale within days, and a wrong line number
 *          reads as authority. What the checks actually depend on - the gate, the debounce, the
 *          selectors below - did not change, which is why they still run.
 *   RENDER `MessageMetadata.svelte`: the sender's own last-read message (the read-receipt
 *          ANCHOR - only one message ever carries this, WhatsApp-style) renders
 *          `.msg-status.msg-status-read[role=status]` with up to 3 reader avatars, a `+N` past
 *          three, a CheckCheck icon and an sr-only label; a sent-but-unread own message renders
 *          `.msg-status.msg-status-sent[role=status]`. THESE TWO CLASSES ARE THE ONLY SELECTORS
 *          USED HERE - they are stable and language-independent, unlike the sr-only text.
 *
 * THE SIDEBAR UNREAD BADGE HAS NO CLASS NAME AT ALL (`ConversationTile.svelte` ships only
 * Tailwind utility classes - `rounded-full bg-red-500 ...` - despite the surrounding comment
 * calling it a "badge"). The one thing that survives a restyle is that it is the ONLY `<span>` in
 * a conversation row carrying an `aria-label`: the avatar (`Avatar.svelte`) is a `<div>`, and the
 * sync badge next to it has no `aria-label` at all. `unreadBadgeExpr` below locates it by that,
 * and reads its VISIBLE text (just the number, or "99+" - never translated prose) rather than the
 * aria-label, which IS a full Paraglide sentence and is deliberately never matched on.
 *
 * WHY THERE IS NO `sleep` DRIVING THE PASS/FAIL ASSERTIONS. Every deadline here is the app's (the
 * 2 s debounce), so each wait is a poll for a STATE with a bound derived from that constant plus
 * slack for the CDP round trip. Sleeps appear only where the spec calls for a NEGATIVE window
 * (READ-3, READ-6, READ-10: "prove it stays absent, not just that it hasn't arrived yet").
 *
 * OBSERVATION IS PART OF EVERY CHECK HERE TOO, and it was missing until 2026-08-15: this runner
 * asserted its outcomes and never classified a single console line, so eight PASSes rested on
 * "nothing I looked at was wrong" while nobody looked at the logs. MSG and TYPE have wrapped each
 * check in `watch` + `report` + `gate` since the phase that found WP-LOSS-1; READ now does the same,
 * and a check whose clients emitted an unexplained line reads `PASS-DIRTY`, not `PASS`.
 *
 *   bun read.mjs                    # all runnable checks
 *   bun read.mjs --only 1           # one check
 *   bun read.mjs --destructive      # also runs READ-10 (creates + deletes a throwaway group)
 */
import {
  client,
  ensureChat,
  ensureConversation,
  evaluate,
  goto,
  openChannel,
  openDM,
  PANE,
  parkConversation,
  realClick,
  reloadAndWait,
  send,
  TILE_BY_TITLE,
  awaitMessage,
  countMessage,
  sameAccountAs,
  until,
} from '../chat.mjs';
import { armCut, cutHard } from './net.mjs';
import { gate, ignoringNavigation, ignoringOfflineCut, report, watch } from '../watch.mjs';
import { errorDetail, mark, markSeq, record } from '../results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS } from '../names.mjs';

const { W1, W2 } = PORTS;

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;
const DESTRUCTIVE = argv.includes('--destructive');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The unread badge of the sidebar row whose visible text contains `name`.
 *
 * Returns `null` when the ROW itself cannot be found (list not loaded yet, or the wrong page is
 * on screen - `document.querySelectorAll` over an empty sidebar is a harness fault, not a "0
 * unread" reading), `''` when the row exists with no badge, or the badge's own text ('3', '99+').
 *
 * **IT READS THE TILE'S TITLE NOW, AND IT USED TO SEARCH FOR THE NAME ANYWHERE AND BREAK TIES BY
 * SHORTEST TEXT** - the same heuristic that made `openConversation` send into a group it was never
 * asked for. A tile is `<initials>` / `<title>` / `<last message preview>`, and a group whose
 * preview says "<owner> a ajoute <peer> au groupe" matches the peer's name exactly as well as the
 * peer's own DM row does. Measured 2026-09-04: with W1 parked on the sidebar and two messages
 * arriving, this returned the row for `Repro Alpha` - a GROUP - which carries no unread badge, so
 * READ-9 waited 30 s for a count that was sitting on a row it was not looking at and reported that
 * the application had failed to count an unread message.
 *
 * `TILE_BY_TITLE` in `chat.mjs` is the one implementation, shared with `openConversation`, and it
 * REFUSES an ambiguous match rather than picking. Ambiguity therefore reads as `null` here - "the
 * row cannot be identified" - which is the same answer as a missing row and deliberately NOT the
 * same as "no badge".
 */
const unreadBadgeExpr = (name) => `(function () {
  var r = (${TILE_BY_TITLE})(${JSON.stringify(name)});
  if (!r.ok) return null;
  var badge = r.el.querySelector('span[aria-label]');
  return badge ? (badge.innerText || '').trim() : '';
})()`;

/** The badge as a NUMBER, treating "no badge" the same as "no row" - see the callers for why. */
async function unreadCountOf(cx, name) {
  const raw = await evaluate(cx, unreadBadgeExpr(name));
  if (raw === null || raw === '') return 0;
  return raw === '99+' ? 100 : parseInt(raw, 10) || 0;
}


/**
 * READ's name for {@link parkConversation}, which now lives in `chat.mjs`.
 *
 * IT MOVED BECAUSE A THIRD CALLER NEEDED IT. `deadrows.mjs` has to park a phone before it can read
 * the sidebar, and READ-10's teardown has to park each of the owner's devices - and on A1 a plain
 * `goto('/chat')` is refused outright (it reloads the Tauri webview and re-locks the PIN), so
 * "get to the list" is exactly this gesture and nothing else. A private copy in a fourth file is how
 * the composer-means-open fault got into three files to begin with.
 */
const leaveConversation = parkConversation;

/** Predicate: the row is found AND carries a badge. Precondition-arming, not the pass condition. */
const unreadHasCount = (name) =>
  `(function () { var v = ${unreadBadgeExpr(name)}; return v !== null && v !== ''; })()`;

/**
 * Predicate: the row's badge has reached AT LEAST `n`.
 *
 * `unreadHasCount` says so itself - it arms a precondition, it is not a pass condition - and READ-8
 * used it as the wait that gates one anyway. It returns at the FIRST non-empty badge, which during
 * a burst of arriving messages is reliably a partial count: the check stopped at 4 ms, read 2, and
 * failed against an expected 3 that was still in flight. Waiting for "changed" and asserting
 * "changed to the right value" is rule 2, and the two must be the same predicate.
 */
const unreadAtLeast = (name, n) =>
  `(function () { var v = ${unreadBadgeExpr(name)}; if (v === null || v === '') return false; return (v === '99+' ? 100 : parseInt(v, 10) || 0) >= ${n}; })()`;

/** Predicate: the row is found AND carries none. Deliberately false if the row cannot be found -
 * a missing row is a harness fault, never silently read as "cleared". */
const unreadIsClear = (name) => `(${unreadBadgeExpr(name)} === '')`;

/** True/false expression: does the open conversation's pane contain a `.msg-status-<cls>` node. */
const hasStatus = (cls) =>
  `(function () { var p = ${PANE}; return !!(p && p.querySelector('${cls}')); })()`;

/**
 * The TEXT of the message the read anchor is currently attached to, or `''`.
 *
 * `hasStatus('.msg-status-read')` asks whether the PANE contains a read indicator anywhere, and on a
 * conversation this campaign has been sending into for weeks the answer is permanently yes: the
 * anchor left by the previous check is still on screen. READ-3 read that stale anchor as proof that
 * a hidden tab had sent a receipt, and reported an application defect that had not happened -
 * `readWhileHidden: true` with `readMs: 2`, far too fast to be a receipt anyone had just sent.
 *
 * Only ONE message ever carries the anchor (`isReadReceiptAnchor`, the last read own message), so
 * the question that discriminates is not whether it exists but WHICH message it sits on. Comparing
 * that against this check's own marker is rule 2: "did it change into the RIGHT state".
 *
 * **IT CLIMBS TO THE APP'S OWN HOOK NOW, AND IT USED TO GUESS BY TEXT LENGTH.** The walk returned the
 * first ancestor whose `innerText` was `> 12 && < 600` characters - and the metadata row that HOLDS
 * the indicator is `"<initials>
Message lu"`, which measured 13. So the climb stopped one level
 * short of the bubble, every time, by a margin of one character. The consequences were both halves of
 * READ-3: `readWhileHidden` was false because a marker can never appear in "CT Message lu", making
 * the negative half true BY CONSTRUCTION, and `readMs` was null because the positive half asks the
 * same question - so the row could not pass and its FAIL said nothing about the application. Measured
 * 2026-09-04: W1 sends the receipt correctly, `[OUTBOX] ... (control) ... sent`, six seconds after
 * visibility is restored.
 *
 * `MessageBubble.svelte` gives every message `id="msg-<messageId>"`. That is a structural fact the
 * app maintains, where a text length is a coincidence this rig was relying on.
 */
const readAnchorText = `(function () {
  var p = ${PANE};
  var s = p && p.querySelector('.msg-status-read');
  if (!s) return '';
  var bubble = s.closest('[id^="msg-"]');
  return bubble ? (bubble.innerText || '').trim() : '';
})()`;

/**
 * Open the observation window BEFORE navigating, so the navigation is INSIDE it.
 *
 * THIS FUNCTION USED TO DO THE OPPOSITE, and the reversal is the finding. READ-1, READ-2 and READ-4
 * each read `PASS-DIRTY` on exactly one `Network.webSocketClosed`, and the first explanation - that
 * the window inherited a close belonging to the document the navigation had just replaced - was
 * believed on one requestId from `wsclose.mjs` and was WRONG. Opening the window later changed
 * nothing, because the close being reported came from the check's SECOND navigation: `openDM` is
 * `goto` is `Page.navigate`, and `chat.mjs` has said all along that a navigation is a disconnection.
 *
 * Two measurements settled it. `wsidle.mjs` left W1 and W2 alone for eight minutes and counted ZERO
 * closes on both, which killed the idle-timeout reading outright. `navclose.mjs` then navigated
 * three times and counted three main-frame `Page.frameNavigated`, three `webSocketCreated`, three
 * `webSocketClosed` and three `Code: 1006` lines - one document replacement, one close, exactly.
 *
 * So the close is not hidden from the window, it is ATTRIBUTED inside it: `ignoringNavigation`
 * forgives at most `documentsReplaced` of them and the next one is still dirt. That keeps the
 * campaign's loss class visible - WP-RECONNECT-2 IS a live socket dying - which the "ignore a close
 * whose open I never saw" rule would have silenced, and it keeps the new page's BOOT under
 * observation, which a late-opening window cannot do.
 */
async function gotoWatched(cx, path, label) {
  const w = await watch(cx, label);
  await goto(cx, path);
  return w;
}

/** Every `Runtime.exceptionThrown` a client has logged since its connection opened. */
const exceptionsOf = (cx) =>
  cx.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) =>
      String(e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text).slice(0, 200)
    );

// ─── READ-1: the core loop - unread badge clears, sender flips sent -> read ──────────────────────
async function read1() {
  const [w1, w2] = await Promise.all([client(W1), client(W2)]);
  // W1 must NOT already have the DM open when the marker lands, or the optimistic mark-read
  // (MainChatPage.svelte:434, setTimeout(...,0)) fires the instant it arrives and there is no
  // "clears" transition left to observe.
  const oW1 = await gotoWatched(w1, '/chat', 'reader');
  await openDM(w2, OWNER_NAME);

  const oW2 = await watch(w2, 'sender');
  const before = await unreadCountOf(w1, PEER_NAME);
  const m = mark('READ1');
  await send(w2, `${m} read receipt probe`);

  // Precondition: the sidebar badge must actually go unread before "it clears" means anything.
  const armedMs = await until(w1, unreadHasCount(PEER_NAME), 15000, 100).catch(() => null);
  if (armedMs === null) {
    record('READ-1', 'VACUOUS', {
      reason: 'sidebar unread badge never appeared on W1 - nothing to prove clears',
      marker: m,
      before,
    });
    [w1, w2].forEach((c) => c.close());
    return null;
  }

  await openDM(w1, PEER_NAME);
  const clearedMs = await until(w1, unreadIsClear(PEER_NAME), 6000, 100).catch(() => null);

  // 2 s debounce (MainChatPage.svelte:452) + slack for the CDP round trip and the MLS send itself.
  const readMs = await until(w2, hasStatus('.msg-status-read'), 6000, 100).catch(() => null);
  const stillSent = readMs === null ? await evaluate(w2, hasStatus('.msg-status-sent')) : null;

  const ok = clearedMs !== null && readMs !== null;
  // W1 navigated twice inside its own window (`/chat`, then the DM), so up to two socket teardowns
  // are this check's doing. W2 navigated before its window opened and is judged unforgiven.
  const gated = gate(ok ? 'PASS' : 'FAIL', {
    W1: ignoringNavigation(await report(oW1)),
    W2: await report(oW2),
  });
  record('READ-1', gated.verdict, {
    ...gated.detail,
    marker: m,
    before,
    armedMs,
    clearedMs,
    readMs,
    stillSent,
    bound: '<=6000ms (2s debounce + slack)',
  });
  [w1, w2].forEach((c) => c.close());
  return ok;
}

/**
 * Is A1 reachable, and is it really the SAME account as W1?
 *
 * The mechanism and the fault that produced it now live in `chat.mjs` `sameAccountAs` - MUT-18 needs
 * the identical question about the identical pair, and two copies of "is this the same user" is the
 * one duplication this campaign cannot afford: they would drift, and the check that drifted would go
 * on passing. This wrapper only supplies the phone's port and origin.
 */
async function a1SameAccountAs(w1) {
  const probe = await sameAccountAs(w1, PORTS.A1, 'tauri.localhost');
  return probe.ok ? { ok: true, a1: probe.cx } : probe;
}

// ─── READ-2: the SAME user's other device clears too ─────────────────────────────────────────────
async function read2() {
  const w1 = await client(W1);
  const probe = await a1SameAccountAs(w1);
  if (!probe.ok) {
    record('READ-2', 'SKIPPED', { reason: probe.why, checked: true });
    w1.close();
    return null;
  }
  const { a1 } = probe;
  const w2 = await client(W2);
  await openDM(w2, OWNER_NAME);

  // Neither of this user's devices may be LOOKING at the conversation, or the receipt fires from
  // whichever is and there is nothing left to observe clearing.
  const oW1 = await gotoWatched(w1, '/chat', 'reader');
  const parked = await leaveConversation(a1);

  const [oW2, oA1] = [await watch(w2, 'sender'), await watch(a1, 'phone')];
  const N = 2;
  const markers = [];
  for (let i = 1; i <= N; i++) {
    const mk = markSeq('READ2', i);
    await send(w2, `${mk} cross-device probe`);
    markers.push(mk);
  }
  await awaitMessage(w2, markers[N - 1], 20000);

  // A1 must actually SHOW the unread before W1 reads it away, or "it cleared" is unfalsifiable.
  const armedMs = await until(a1, unreadAtLeast(PEER_NAME, 1), 30000, 200).catch(() => null);

  // W1 reads. The watermark is per-USER, so A1's own count must follow without A1 doing anything.
  await openDM(w1, PEER_NAME);
  const clearedMs =
    armedMs === null ? null : await until(a1, unreadIsClear(PEER_NAME), 30000, 200).catch(() => null);

  const ok = armedMs !== null && clearedMs !== null;
  const gated = gate(ok ? 'PASS' : 'FAIL', {
    // W1 navigated twice in-window (`/chat`, then the DM it reads). A1 is only clicked and W2
    // navigated before its window opened, so neither is forgiven anything.
    W1: ignoringNavigation(await report(oW1)),
    W2: await report(oW2),
    A1: await report(oA1),
  });
  record('READ-2', gated.verdict, {
    ...gated.detail,
    markers,
    parked,
    armedMs,
    clearedMs,
    note: 'A1 is never touched after the messages land - the clear must come from W1 reading, via the per-user watermark.',
  });
  [w1, w2, a1].forEach((c) => c.close());
  return ok;
}

// ─── READ-3: hidden + unfocused tab must send NOTHING, then prove it was ARMED ───────────────────
async function read3() {
  const w2 = await client(W2);
  // FOCUS EMULATION OFF, ON PURPOSE. Every other check in this campaign turns it ON so all three
  // clients can claim to be "the active window" at once (chat.mjs's `client()` doc) - that lie is
  // what makes DM receipts possible from an unattended rig at all. This is the one check where
  // the lie itself must be absent: `{ focus: false }`, PLUS `document.visibilityState` forced to
  // `hidden` via the Page lifecycle domain, so BOTH halves of the gate
  // (`isWindowFocused && isTabVisible`, MainChatPage.svelte:416) fail, not just one.
  const w1 = await client(W1, null, { focus: false });

  /**
   * PARK EVERY OTHER DEVICE OF THIS USER AWAY FROM THE CONVERSATION FIRST.
   *
   * The read watermark is per-USER, not per-device, so "this tab must send nothing" is only
   * observable if no OTHER device of the same account is looking at the thread. A1 is a second
   * device of W1's user, and READ-9 leaves it sitting in this very DM - so the marker was read
   * instantly by the phone, W2's anchor moved, and READ-3 reported that a hidden tab had sent a
   * receipt. `readMs: 1` was the tell: nothing that crosses a network arrives in a millisecond.
   *
   * The fault is an INTERACTION between checks, which is why it appeared only once READ-2 and
   * READ-9 started running - a phase is not a set of independent checks unless each one puts the
   * fleet into the state it assumes.
   */
  const other = await a1SameAccountAs(w1);
  const parked = other.ok ? await leaveConversation(other.a1) : 'no second device';
  if (other.ok) other.a1.close();

  await openDM(w1, PEER_NAME);
  await openDM(w2, OWNER_NAME);

  // `Page.setWebLifecycleState` TAKES ONLY `frozen` OR `active`. This asked for `hidden`, which is
  // not a lifecycle state at all, so the call threw `Unidentified lifecycle state (-32000)` and the
  // VACUOUS guard below - written for exactly this - never got to run: the check reported ERROR on
  // every execution. `frozen` is not the substitute either, because a frozen page does not run
  // timers, and the positive half of this check needs the 2 s debounce to fire.
  //
  // So drive what the APPLICATION actually reads. `isTabVisible` comes from
  // `document.visibilityState` plus the `visibilitychange` event, and both are overridden here -
  // this is emulation, and it is named as such, but it is emulation of the exact input the gate
  // consumes rather than of something adjacent to it.
  const hiddenOk = await evaluate(
    w1,
    `(function () {
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'hidden'; } });
        Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
        return document.visibilityState === 'hidden';
      } catch (e) { return false; }
    })()`
  );
  if (!hiddenOk) {
    record('READ-3', 'VACUOUS', {
      reason:
        'document.visibilityState could not be overridden to hidden on this build - the negative half cannot be armed',
      hiddenOk,
    });
    [w1, w2].forEach((c) => c.close());
    return null;
  }

  const [oW1, oW2] = [await watch(w1, 'hidden-reader'), await watch(w2, 'sender')];
  const m = mark('READ3');
  await send(w2, `${m} hidden tab probe`);
  await awaitMessage(w2, m, 15000); // sender sees its own send land - not a receipt

  // Negative half: hold hidden + unfocused well past the 2 s debounce and assert nothing crosses.
  //
  // ASKED OF THIS MARKER, NOT OF THE PANE. The anchor from the previous check is still rendered, so
  // "is there a read indicator" is permanently true here and proves nothing about this message.
  await sleep(6000);
  const stillSentHidden = await evaluate(w2, hasStatus('.msg-status-sent'));
  const anchorWhileHidden = await evaluate(w2, readAnchorText);
  const readWhileHidden = anchorWhileHidden.includes(m);

  // Positive half: restore both conditions and prove the check was ARMED, not just broken - a
  // receipt that never arrives is worthless if nothing here could ever have sent one.
  await evaluate(
    w1,
    `(function () {
      delete document.visibilityState;
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    })()`
  );
  await w1.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(w1, `window.dispatchEvent(new Event('focus'))`); // the app listens on window, not document
  // The positive half asks the same question the negative one did, so a pass means the anchor MOVED
  // onto this marker rather than merely existing somewhere.
  const readMs = await until(
    w2,
    `(${readAnchorText}).indexOf(${JSON.stringify(m)}) !== -1`,
    8000,
    100
  ).catch(() => null);

  // THE PARK IS A PRECONDITION, SO IT IS PART OF THE VERDICT. If the other device could not be got
  // out of the conversation, "nothing was read while hidden" was never this tab's to prove.
  const parkedOk = ['no second device', 'already outside a conversation', 'left'].includes(parked);
  const ok = parkedOk && stillSentHidden === true && readWhileHidden === false && readMs !== null;
  const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(oW1), W2: await report(oW2) });
  record('READ-3', gated.verdict, {
    ...gated.detail,
    marker: m,
    parked,
    stillSentHidden,
    readWhileHidden,
    readMs,
    anchorWhileHidden: anchorWhileHidden.slice(0, 60),
  });
  [w1, w2].forEach((c) => c.close());
  return ok;
}

// ─── READ-4: 20 rapid markers must batch into ONE debounced flush, not trickle ───────────────────
async function read4() {
  const [w1, w2] = await Promise.all([client(W1), client(W2)]);
  const oW1 = await gotoWatched(w1, '/chat', 'reader'); // NOT looking at the DM while they land
  await openDM(w2, OWNER_NAME);

  const oW2 = await watch(w2, 'sender');
  const N = 20;
  const markers = [];
  for (let i = 1; i <= N; i++) {
    const mk = markSeq('READ4', i);
    await send(w2, `${mk} batch probe`);
    markers.push(mk);
  }
  await awaitMessage(w2, markers[N - 1], 15000);

  await openDM(w1, PEER_NAME);
  const readMs = await until(w2, hasStatus('.msg-status-read'), 8000, 100).catch(() => null);

  // WHY THIS IS THE ONLY OBSERVABLE SIGNAL. `MessageMetadata.svelte` renders the read indicator
  // ONLY on `isReadReceiptAnchor` (the last own message) - the other 19 have no per-message DOM
  // hook for their `readBy` at all, so "did all 20 flip" cannot be read off the page one message
  // at a time, and the WS frames carrying the batch are MLS ciphertext, so their content cannot
  // be inspected either. What CAN be read off the page is whether the ONE visible flip lands
  // inside a single 2 s debounce window (MainChatPage.svelte:452) or trickles in over many
  // seconds the way 20 separate per-id sends would - so the bound below is an INFERENCE from
  // timing, not a direct observation of the batch. See `note`.
  const ok = readMs !== null && readMs <= 6000;
  // Two in-window navigations on W1 (`/chat`, then the DM), as in READ-1.
  const gated = gate(ok ? 'PASS' : 'FAIL', {
    W1: ignoringNavigation(await report(oW1)),
    W2: await report(oW2),
  });
  record('READ-4', gated.verdict, {
    ...gated.detail,
    sent: N,
    firstMarker: markers[0],
    lastMarker: markers[N - 1],
    readMs,
    bound: '<=6000ms (2s debounce + slack)',
    note:
      'batching is INFERRED from timing, not observed directly: only the last own message renders a read indicator, so per-id transitions for the other 19 are not visible in the DOM, and the WS frames are MLS ciphertext.',
  });
  [w1, w2].forEach((c) => c.close());
  return ok;
}

// ─── READ-5: SKIPPED - "+N" needs a 4th reader, only 2 test accounts exist ───────────────────────
function read5() {
  record('READ-5', 'SKIPPED', {
    reason:
      'the "+N" overflow only renders past 3 readers (readBy.length > 3, MessageMetadata.svelte line 118), and this campaign has exactly 2 test accounts - there is no way to produce a 4th reader.',
  });
  return null;
}

// ─── READ-6: a channel message must NEVER carry an MLS read receipt ──────────────────────────────
async function read6() {
  const [w1, w2] = await Promise.all([client(W1), client(W2)]);
  await openChannel(w2);
  await openChannel(w1);

  const m = mark('READ6');
  await send(w2, `${m} channel no-receipt probe`);
  await awaitMessage(w1, m, 15000);

  // Clear the log HERE, not at connection start - everything before this point is navigation
  // noise, and folding it in would blame this check for an unrelated page-load error. `watch` does
  // exactly that clear, so it is also where the observation window opens.
  const [oW1, oW2] = [await watch(w1, 'channel-viewer'), await watch(w2, 'sender')];

  // W1 sits on it focused + visible + open - exactly the state that fires a DM receipt. The
  // channel branch (`if (isSelectedChannel) return;`, MainChatPage.svelte:420) must return before
  // ever calling `sendReadReceipt` - routing a channel id through the MLS outbox is what the
  // surrounding comment says loops forever on resolveTerminalGroup/welcome-request 500s.
  await sleep(4000); // full debounce window + slack, for a receipt that must never be sent

  const readAppeared = await evaluate(w2, hasStatus('.msg-status-read'));
  const exceptions = exceptionsOf(w1);

  // `exceptionsOf` is kept ALONGSIDE the classifier rather than replaced by it: this verdict is
  // about exceptions specifically, and a verdict may not be computed over a projection of its own
  // evidence (rule 1). `gate` then adds whatever else the window contained.
  const ok = readAppeared === false && exceptions.length === 0;
  const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(oW1), W2: await report(oW2) });
  record('READ-6', gated.verdict, { ...gated.detail, marker: m, readAppeared, exceptions });
  [w1, w2].forEach((c) => c.close());
  return ok;
}

// ─── READ-7: a reload mid-flight must not resurrect or double-count the unread badge ─────────────
async function read7() {
  const [w1, w2] = await Promise.all([client(W1), client(W2)]);
  await goto(w1, '/chat');
  await openDM(w2, OWNER_NAME);

  const oW2 = await watch(w2, 'sender');
  const before = await unreadCountOf(w1, PEER_NAME);
  const m = mark('READ7');
  await send(w2, `${m} reload race probe`);

  const armedMs = await until(w1, unreadHasCount(PEER_NAME), 15000, 100).catch(() => null);
  if (armedMs === null) {
    record('READ-7', 'VACUOUS', {
      reason: 'sidebar unread badge never appeared on W1 before the reload race - nothing to race',
      marker: m,
      before,
    });
    [w1, w2].forEach((c) => c.close());
    return null;
  }

  // Open the DM - arms the optimistic mark-read (setTimeout(...,0)) and the 2 s debounced send -
  // then reload WHILE the receipt is in flight, well inside the window, never after it resolved.
  await openDM(w1, PEER_NAME);
  await sleep(500);
  // `reloadAndWait`, NOT reload-then-poll: the poll sends `Runtime.evaluate` into the context this
  // very line is destroying, and CDP answers `Inspected target navigated or closed` when the two
  // meet. This row ERRORed on three runs in four that way, recording no verdict at all.
  await reloadAndWait(w1);
  await openDM(w1, PEER_NAME); // reload drops all SPA state; re-open the way a real user would

  // W1 IS WATCHED ONLY FROM HERE. The reload this check performs is its own instrument, and the
  // teardown it produces - a socket closing, in-flight fetches failing - is the check working, not
  // the app failing. What must be clean is the page that comes BACK.
  const oW1 = await watch(w1, 'reloaded-reader');

  const afterMs = await until(w1, unreadIsClear(PEER_NAME), 10000, 100).catch(() => null);
  const after = await unreadCountOf(w1, PEER_NAME);
  const dupCount = await countMessage(w1, m);

  const ok = afterMs !== null && after === 0 && dupCount === 1;
  const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(oW1), W2: await report(oW2) });
  record('READ-7', gated.verdict, {
    ...gated.detail,
    marker: m,
    before,
    armedMs,
    afterMs,
    after,
    dupCount,
  });
  [w1, w2].forEach((c) => c.close());
  return ok;
}

// ─── READ-8: messages that arrived while offline must be counted on reconnect ────────────────────
async function read8() {
  const [w1, w2] = await Promise.all([client(W1), client(W2)]);
  await goto(w1, '/chat'); // sidebar visible, nothing open
  await openDM(w2, OWNER_NAME);

  // A REAL DISCONNECTION, NOT `emulateNetworkConditions` ALONE. That setting fails NEW requests and
  // leaves the ESTABLISHED WebSocket untouched, so W1 kept taking the "offline" messages live and
  // the premise of this check - a device that was away while they were sent - was never established
  // (rule 7, the same trap that made TYPE-4 report a delivery defect it had manufactured).
  //
  // `armCut` RELOADS to patch the socket constructor, so it has to come before the baseline: a
  // count read on the pre-reload page describes a sidebar that no longer exists.
  await armCut(w1);
  const oW2 = await watch(w2, 'sender');
  const before = await unreadCountOf(w1, PEER_NAME);
  // W1's window opens with the cut, so it CONTAINS the outage - which is why its report is read
  // through `ignoringOfflineCut`: the failed fetches and the closed socket are this check working.
  // Exceptions, `notable` and `severe` are not forgiven by it, and neither is anything left
  // unclassified, so the outage buys silence for its own consequences and for nothing else.
  const oW1 = await watch(w1, 'offline-reader');
  const cut = await cutHard(w1);

  const N = 3;
  const markers = [];
  for (let i = 1; i <= N; i++) {
    const mk = markSeq('READ8', i);
    await send(w2, `${mk} offline-inbox probe`);
    markers.push(mk);
  }
  // W2 finishes delivering to the server before W1 comes back - otherwise "online" races the
  // server's own fan-out and the badge count would depend on that race, not on the app.
  await awaitMessage(w2, markers[N - 1], 15000);

  await cut.restore();

  // W1 is NEVER told to open the conversation - the assertion is entirely about what a reconnect
  // alone produces in the sidebar.
  //
  // WAIT FOR THE COUNT THIS CHECK IS ABOUT, not for any count at all. The three messages arrive as
  // a burst, so the first non-empty badge is a PARTIAL total - the old wait returned at 4 ms with 2
  // on screen and the verdict then compared that partial against 3. The deadline expiring is the
  // failure; reaching the number early is the pass.
  const badgeMs = await until(w1, unreadAtLeast(PEER_NAME, before + N), 30000, 100).catch(() => null);
  const after = await unreadCountOf(w1, PEER_NAME);
  const delta = after - before;

  const ok = badgeMs !== null && delta === N;
  const gated = gate(ok ? 'PASS' : 'FAIL', {
    W1: ignoringOfflineCut(await report(oW1)),
    W2: await report(oW2),
  });
  record('READ-8', gated.verdict, {
    ...gated.detail,
    markers,
    before,
    after,
    delta,
    expected: N,
    badgeMs,
  });
  [w1, w2].forEach((c) => c.close());
  return ok;
}

// ─── READ-9: reading on A1 clears W1's count LIVE, with no reload ────────────────────────────────
async function read9() {
  const w1 = await client(W1);
  const probe = await a1SameAccountAs(w1);
  if (!probe.ok) {
    record('READ-9', 'SKIPPED', { reason: probe.why, checked: true });
    w1.close();
    return null;
  }
  const { a1 } = probe;
  const w2 = await client(W2);
  await openDM(w2, OWNER_NAME);

  // W1 watches the SIDEBAR with the conversation closed: open it and W1 would read the messages
  // itself, which is READ-1's assertion, not this one.
  const oW1 = await gotoWatched(w1, '/chat', 'sidebar-watcher');
  const parked = await leaveConversation(a1);

  const [oW2, oA1] = [await watch(w2, 'sender'), await watch(a1, 'phone-reader')];
  const N = 2;

  // THE COUNT THIS ROW ALREADY HAD, because `unreadAtLeast(..., 1)` is true the instant a LEFTOVER
  // badge exists and would arm on nothing. Measured 2026-09-04: after the badge locator was
  // repaired this row armed in 1 ms - the row's own doc says nothing crossing a network arrives that
  // fast - because two messages from an earlier probe were still unread. Asking for `before + N` is
  // rule 2: wait for CHANGED, assert changed to the RIGHT value.
  const before = await unreadCountOf(w1, PEER_NAME);

  const markers = [];
  for (let i = 1; i <= N; i++) {
    const mk = markSeq('READ9', i);
    await send(w2, `${mk} reverse cross-device probe`);
    markers.push(mk);
  }
  await awaitMessage(w2, markers[N - 1], 20000);

  const armedMs = await until(w1, unreadAtLeast(PEER_NAME, before + N), 30000, 200).catch(() => null);

  // The phone reads. `ensureConversation` rather than a navigation: a reload on A1 re-locks the PIN
  // and a check that navigates it hangs on a modal it never expected.
  await ensureConversation(a1, PEER_NAME);

  // NO RELOAD ON W1 - that is the entire claim. A count that only corrects on refresh is the defect
  // this check exists to catch, and reloading before reading would hide it.
  const clearedMs =
    armedMs === null ? null : await until(w1, unreadIsClear(PEER_NAME), 30000, 200).catch(() => null);

  const ok = armedMs !== null && clearedMs !== null;
  const gated = gate(ok ? 'PASS' : 'FAIL', {
    // ONE in-window navigation on W1 (`/chat`) and no more - it must never open the DM here, which
    // is the whole claim. A second forgiven close would mean this check had read the messages itself.
    W1: ignoringNavigation(await report(oW1)),
    W2: await report(oW2),
    A1: await report(oA1),
  });
  record('READ-9', gated.verdict, {
    ...gated.detail,
    before,
    markers,
    parked,
    armedMs,
    clearedMs,
    note: 'W1 is never reloaded - the count must clear live, from the watermark A1 sent.',
  });
  [w1, w2, a1].forEach((c) => c.close());
  return ok;
}

// ─── READ-10: reading a conversation the PEER has deleted - opt-in, --destructive only ───────────
async function read10() {
  if (!DESTRUCTIVE) {
    record('READ-10', 'SKIPPED', {
      reason:
        'crosses into the DEL phase: creates a throwaway group and deletes it, leaving debris the campaign cleanup has to know about. Opt in with --destructive.',
    });
    return null;
  }

  // Reuses the group create/invite/delete plumbing `del1.mjs` already proved out for
  // WP-HISTGHOST-1 - same roster-search-by-elimination for "who is the peer" (the picker never
  // offers an existing member, so trying candidates in turn and watching the roster go 1 -> 2 is
  // the only reliable way to know, per del1.mjs's own comment on why parsing a name off the page
  // picked the wrong account there).
  const { deleteGroup, dismissLocally, openGroup } = await import('../groupnav.mjs');
  // (`usernames` is no longer needed here - see the display-name note below.)

  const NAME = `READ10-${Date.now().toString(36)}`;
  const w2 = await client(W2); // the PEER: creates the group, sends, then deletes it
  const w1 = await client(W1); // the OWNER: whose read path must survive the dead conversation

  // THE SHARED GESTURE, and this call site is why it exists: the six lines that used to be here
  // waited for `#new-group-name` BEFORE clicking the "Groupe" tab that creates it, so READ-10 died
  // on a ten-second timeout every time and had never produced a verdict. See `createGroup`.
  const { createGroup } = await import('../groupnav.mjs');
  await goto(w2, '/chat');
  await createGroup(w2, NAME, { label: 'read10' });
  await openGroup(w2, NAME, { navigate: true, label: 'read10-create' });

  // THE SHARED GESTURE, and this is the call site that proves why it must be shared. What used to be
  // here re-implemented the member picker and was missing all three of `addmember.mjs`'s lessons: it
  // took `[0]` of any small floating list (the dropdown is PORTALLED, and the sidebar's own DM row
  // for that person matches an unscoped search), it clicked through `realClick` on a global
  // `'ul li, ol li'` rather than dispatching a real pointer sequence at the option's own centre
  // (`element.click()` leaves "Envoyer l'invitation" DISABLED), and it waited for `MEMBRES (2)` -
  // a rendering of the outcome rather than the outcome. READ-10 had never produced a verdict.
  // DISPLAY NAMES, NOT LOGINS, and this is the second half of why READ-10 never produced a verdict.
  // `usernames()` says in its own doc that it is "for the member pickers that search by it"; the
  // picker offered neither login, which is what the refusal list this call now carries said in as
  // many words. The picker renders and matches display names.
  //
  // Both are tried rather than the one `peerNameFor` would name, because which account is the peer
  // is a property of the GROUP, not of the device: the picker never offers an existing member or
  // yourself, so being accepted is what identifies them.
  // EVERYTHING FROM HERE IS WRAPPED, because the group deletion IS this check's stimulus and a run
  // that dies before it leaves a LIVE group on production. Measured on prod 2026-08-21: of the
  // twenty-five throwaway groups every phase has ever built, twenty-three were tombstoned as designed
  // and TWO were still alive - both from READ-10 runs that died at the invite step, on the two days
  // this check was being repaired. Rule 8, in its own words: a cleanup that only runs on the happy
  // path is not a cleanup.
  let a1probe = { ok: false, why: 'not probed' };
  try {
    const { addAnyMember } = await import('./addmember.mjs');
    const { OWNER_NAME, PEER_NAME } = await import('../names.mjs');
    let peer;
    try {
      peer = await addAnyMember(w2, [OWNER_NAME, PEER_NAME]);
    } catch (e) {
      record('READ-10', 'ERROR', {
        reason: 'could not invite the peer into the throwaway group',
        group: NAME,
        // THE REFUSALS, not just the fact of refusal: `addAnyMember` names what each candidate did,
        // and a bare "could not invite" is what made this row unactionable for a fortnight.
        why: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
    console.log(`[read10] invited ${JSON.stringify(peer)}`);
    await realClick(w2, 'text=Fermer').catch(() => {});

    const m = mark('READ10');
    await send(w2, `${m} pre-delete probe`);

    // W1 receives it and holds it unread BEFORE the delete - the row it opens afterward must carry
    // something for the read gate to have skipped, or a green result would mean nothing.
    await until(w1, `document.body.innerText.indexOf(${JSON.stringify(NAME)}) !== -1`, 60000);
    await openGroup(w1, NAME, { navigate: true, label: 'read10-w1-before' });
    await awaitMessage(w1, m, 20000);
    await goto(w1, '/chat'); // leave it unread and unopened before the peer deletes it

    // The PEER deletes the group. The row survives on W1's side with `lifecycle: 'removed'`
    // (deliberate, per WP-HISTGHOST-1 - the UI has to be able to explain the absence).
    await deleteGroup(w2, NAME);
    await sleep(2000);

    // THE WINDOW OPENS HERE, and it is a `watch` rather than a hand-cleared buffer.
    //
    // Clearing the events was right - group create/invite/delete above is noisy by nature (three
    // overlay open/closes on W2) and none of it is what this check is about - but it left READ-10 the
    // ONE check in this file that reads a single bucket. `exceptionsOf(w1)` answers "did anything
    // throw", and the failure this check exists to catch is the opposite shape: a receipt that WAS
    // sent for a dead conversation is an outbound request or a WS frame, neither of which throws
    // anything. It would have passed over the very event it is named for.
    const oR10 = await watch(w1, 'READ-10-W1');

    // W1 opens the now-dead row and "reads" it - focused + visible + open, exactly the state that
    // fires a receipt on an ACTIVE conversation. `convo.lifecycle !== 'active'`
    // (MainChatPage.svelte:422) must have made this a no-op before any of that runs.
    let threw = null;
    try {
      await openGroup(w1, NAME, { navigate: true, label: 'read10-w1-after' });
    } catch (e) {
      threw = e.message;
    }
    await sleep(4000); // full debounce window + slack, for a receipt that must never be sent

    const rW1 = await report(oR10);
    const exceptions = rW1.exceptions;

    // THE CHECK CLEANS UP AFTER ITSELF, and until 2026-08-21 it did not. A row the peer deleted is
    // kept until its owner dismisses it BY HAND - the guard at the top of `decideAbsentGroupFate` -
    // so every run of this check left one more dead `READ10-*` conversation in W1's profile, and each
    // of them narrated itself on every load of every later check. Four had piled up.
    //
    // Part of the VERDICT, not a best-effort teardown, for two reasons: the dismissal is the only exit
    // the product offers that row, so failing it is a real defect on this check's own subject; and a
    // teardown that may silently fail is how the four accumulated in the first place.
    //
    // OUTSIDE the observation window on purpose. `report` has already judged the read path; the
    // purge's own lines belong to the DEL rows that assert them, and folding them in here would let a
    // future unclassified line from a different mechanism decide READ-10's verdict.
    // AND IT CLEANS EVERY DEVICE OF THAT ACCOUNT, not just the one it measured - which the first
    // version got wrong and A1 proved within the hour. The dead row is per-DEVICE local state, and the
    // group was created with the OWNER as a member, so every device that account has holds one: W1 had
    // its row dismissed, the phone kept THREE, and the next check to park the phone found it holding a
    // dead conversation, read "no composer" as "nothing open", and died reporting an empty sidebar on a
    // device with thirteen rows. A per-device teardown that runs on one device is not a teardown.
    //
    // A device it cannot reach is NAMED rather than skipped: unreported debris is what this whole
    // teardown exists to stop, and "A1 was absent" is a fact the next reader needs.
    const owners = [{ label: 'W1', cx: w1 }];
    a1probe = await a1SameAccountAs(w1);
    if (a1probe.ok) owners.push({ label: 'A1', cx: a1probe.a1 });

    const cleaned = {};
    if (threw === null) {
      for (const { label, cx } of owners) {
        try {
          // NOT `goto`: on A1 it reloads the webview and re-locks the PIN, and `chat.mjs` refuses
          // it. Park first, or the phone's list is off screen behind the conversation it is showing.
          await ensureChat(cx);
          await parkConversation(cx);
          await openGroup(cx, NAME, { navigate: false, label: `read10-cleanup-${label}` });
          await dismissLocally(cx, NAME);
          cleaned[label] = true;
        } catch (e) {
          cleaned[label] = e instanceof Error ? e.message : String(e);
        }
      }
      if (!a1probe.ok) cleaned.A1 = `unreachable: ${a1probe.why}`;
    } else {
      cleaned.W1 = 'not attempted - the row never opened';
    }

    const cleanedAll = Object.values(cleaned).every((v) => v === true);
    const ok = threw === null && exceptions.length === 0 && cleanedAll;
    const gated = gate(ok ? 'PASS' : 'FAIL', { W1: rW1 });
    record('READ-10', gated.verdict, {
      ...gated.detail,
      group: NAME,
      marker: m,
      threw,
      exceptions,
      cleaned,
    });
    return ok;
  } finally {
    // THE GROUP, ON EVERY EXIT PATH. `deleteGroup` answers 'not listed' when the stimulus already
    // took it, which is the ordinary case and not an error - so this is a guarantee rather than a
    // second deletion. It runs before the sockets close, and a teardown that cannot finish says so
    // in the log rather than throwing over the verdict that was just recorded.
    try {
      const gone = await deleteGroup(w2, NAME);
      if (gone === 'deleted') console.log(`[read10] teardown deleted ${NAME} - the stimulus never ran`);
    } catch (e) {
      console.log(`[read10] TEARDOWN FAILED for ${NAME}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (a1probe.ok) a1probe.a1.close();
    [w1, w2].forEach((c) => c.close());
  }
}

const CHECKS = {
  1: read1,
  2: read2,
  3: read3,
  4: read4,
  5: read5,
  6: read6,
  7: read7,
  8: read8,
  9: read9,
  10: read10,
};

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`READ-${n}`, 'ERROR', { ...errorDetail(e) });
    results.push([n, false]);
  }
}
console.log(`\nREAD: ${results.filter(([, ok]) => ok === true).length}/${results.length} PASS`);
process.exit(results.every(([, ok]) => ok === true || ok === null) ? 0 : 1);

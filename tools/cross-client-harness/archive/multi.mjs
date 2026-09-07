/**
 * MULTI - one user, two devices. Rung 12 of the ladder.
 *
 * THE PHASE'S SUBJECT IS THE ACCOUNT, NOT THE CONVERSATION. W1 and A1 are two enrolments of the SAME
 * account (the preflight prints `user=d82cd226` for both), so every row here asks something no
 * single-device phase can: does an act on one device reach the other as the SAME person's act. That
 * is a different question from delivery, which MSG and COMM already answer, and it fails differently
 * - a message that arrives on the sibling as if a stranger had sent it is delivered and wrong.
 *
 * TWO OF THE SIX ROWS WILL NEVER HAVE A RUNNER, AND THAT IS STATED HERE RATHER THAN LEFT AS A GAP.
 * A dispatcher that silently skips a row is how a six-row rung reports 4/4 and reads green - `del.mjs`
 * carries the same note over DEL-1 for the same reason.
 *
 *   - MULTI-3 (A1 enrolled AFTER W1 has history) needs a device that does not exist yet, and a first
 *     login on a new device is SETUP-4's 2FA - the one step in this whole rig no tool here can answer.
 *     It is a one-off human action, not a missing script.
 *   - MULTI-4 (revoke A1, then A1 acts) IS device check L in `device-verification.md`
 *     (WP-DEV-PANEL-1), owed on real hardware. And the gesture costs the estate the enrolment it
 *     revokes, which is the same bill `purge-devices.mjs` is impounded for: A1 would come back only
 *     through that same 2FA. Automating it would spend a human's afternoon to save a script a minute.
 *
 * Both record `SKIPPED` with that reason, so the row carries WHY rather than reading as work nobody
 * has got to.
 *
 * WHAT EACH RUNNING ROW ASSERTS, and the surface it reads it on:
 *
 *   MULTI-1  a message sent from W1 renders on A1 as OWN        `[data-own]` on the message row
 *   MULTI-2  a read performed on A1 clears W1's unread          `unreadCount` in W1's store
 *   MULTI-5  three clients of one account on one channel        one copy each, no client loses its socket
 *   MULTI-6  A1 dead through twenty sends, then returns         all twenty, once each, in order
 *
 * MULTI-1 READS AN ATTRIBUTE THE PRODUCT CARRIES FOR THIS PURPOSE, and if that attribute is absent
 * the row records `VACUOUS` rather than `FAIL`. The distinction is `idb.mjs`'s rule promoted to the
 * DOM: "no rows" and "no such store" are different answers, and a check that cannot tell them apart
 * is measuring nothing. Before `data-own` existed, own-ness reached the DOM only as a layout class,
 * so the honest reading of its absence is "the surface is gone", never "the product is wrong".
 *
 *   bun multi.mjs              every runnable row, in order
 *   bun multi.mjs --only 6     one row
 */
import {
  awaitMessage,
  client,
  countMessage,
  ensureChat,
  ensureConversation,
  evaluate,
  lookAway,
  openChannel,
  PANE_STATE,
  send,
} from '../chat.mjs';
import { closeExtraAppTabs } from './tabs.mjs';
import { connect } from '../cdp.mjs';
import {
  gate,
  ignoringExpectedLog,
  logcatReport,
  logcatSince,
  PHONE_COLD_BOOT,
  report,
  watch,
} from '../watch.mjs';
// ANY ROW THAT OPENS THE VENUE CHANNEL RENDERS THE STRANDED MENTION CHIPS, which is what this
// names - see `stranded.mjs`. MULTI-5 collected all three as `badHttp` and was capped at
// `PASS-DIRTY` for months while `fwd.mjs`, `fwd345.mjs` and the MENTION rows already called this.
import { ignoringStrandedMentions } from '../stranded.mjs';
import { errorDetail, mark, record, recordObserved } from '../results.mjs';
import { ACCOUNT_OF, OWNER_NAME, PEER_NAME, PORTS, SITE } from '../names.mjs';
import { unlockClient } from './pingate.mjs';
import { whoIs } from './presence.mjs';
import * as phone from '../phone.mjs';

// THE PHONE THIS RUNNER DRIVES, DECLARED. Every row below is written for A1 - `PORTS.A1`,
// `peerNameFor('A1')` - and with a second phone on the bench `serial()` refuses to choose rather
// than driving the wrong one and reporting success. So the name the rows already assume is stated
// here once, which also sets `ANDROID_SERIAL` for every adb and atom spawned underneath. See
// `useDevice` in `phone.mjs`. A row that ever needs A2 changes this line, deliberately.
phone.useDevice('A1');

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a state that has to CROSS DEVICES is given before its absence is called an absence. */
const CROSS_DEVICE_MS = 60_000;

/** How long A1 stays dead in MULTI-6 - long enough that the sends age in the queue, not a heartbeat. */
const OFFLINE_MS = 60_000;

/** MULTI-6 sends this many. The row's own number, and the only place it is written. */
const BURST = 20;

/** A client and the observer watching it - `grp.mjs`'s twin, and for its reason. */
async function observed(port, label, opts = {}) {
  const cx = await client(port, opts.match ?? null, opts);
  return [cx, await watch(cx, label)];
}

/**
 * Whether the message row carrying `marker` says the account authored it.
 *
 * THREE ANSWERS, NOT TWO. `hookPresent` separates "the product rendered this as someone else's" from
 * "there is nothing here to read", which are a FAIL and a VACUOUS and must never share a cell.
 * `rows` is carried for the same reason `countMessage` exists: two rows holding one marker is a
 * duplicate, and a check reading `[0]` would report the first one's authorship as the whole answer.
 */
const OWNERSHIP = (marker) => `(function () {
  var all = [].slice.call(document.querySelectorAll('[data-own]'));
  var hit = all.filter(function (e) { return (e.innerText || '').indexOf(${JSON.stringify(marker)}) !== -1; });
  return JSON.stringify({
    hookPresent: all.length > 0,
    rows: hit.length,
    own: hit.length ? hit[0].getAttribute('data-own') : null
  });
})()`;

/**
 * The stored unread count for one conversation on `cx`, and the keys of the row it read.
 *
 * THE KEYS ARE PART OF THE ANSWER. `unreadCount` is optional on `ConversationMeta`, so an absent
 * field and a zero are the same JavaScript value and completely different findings - one is "the
 * user has read everything", the other is "this check is reading a field the product stopped
 * writing". Reported as `null` plus the key list, exactly as `fromStore` reports a missing store.
 */
/**
 * W1's own read state for the DM with `peerId`, taken from the mechanism the PRODUCT uses.
 *
 * `unreadCount` IS NOT A FIELD, AND THIS ROW ASKED FOR IT FOR ITS WHOLE LIFE. The reader that stood
 * here matched a conversation by DISPLAY NAME against `r.name` and then read `r.unreadCount`. A
 * stored conversation carries neither: measured on W1's own store 2026-09-07, every row holds
 * exactly `id, name, lifecycle, updatedAt, readWatermarks, historyFloor`, and a DM's `name` is the
 * `<userA>::<userB>` PAIR ID, not a person's name. Both halves of the match were wrong - so the row
 * recorded `VACUOUS` citing the FIRST of its two reasons ("no stored conversation row named the
 * peer") when the true one was the second, which is worse than either: a check naming a cause it
 * never measured. `unreadCount` exists only as a PROP on `ConversationTile`, computed per render.
 *
 * WHAT IS ACTUALLY THERE, and why it is the better subject. Unread is DERIVED from `readWatermarks`
 * (`readState.ts`: `isUnreadForUser(msg, watermarkFor(convo.readWatermarks, me))`), and the
 * watermark map is precisely the thing the account's devices SYNCHRONISE - which is this row's whole
 * question. So the assertion moves onto it: a read performed on A1 must advance the watermark W1
 * holds for the account's own user id.
 *
 * AND IT NEEDS NO KEY. A message at rest is `id, conversationId, timestamp, iv, cipherText` - there
 * is no `senderId`, no `isOwn`, no `isSystem` to count with, so `isUnreadForUser` cannot be
 * reproduced here and this does not pretend to. `timestamp` IS plaintext, which is enough for the
 * two facts the row needs: messages exist past the watermark (unread accrued), and none does after
 * the sibling's read (it cleared).
 */
async function dmReadState(cx, meId, peerId) {
  const me = meId.toLowerCase();
  const peer = peerId.toLowerCase();
  const raw = await evaluate(
    cx,
    `(async () => {
      const has = (s, needle) => String(s || '').toLowerCase().indexOf(needle) !== -1;
      const names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
      const dbName = names.find((n) => n.indexOf('CanariDB_') === 0 && has(n, ${JSON.stringify(me)}));
      if (!dbName) return JSON.stringify({ found: false, why: 'no CanariDB for this account', dbs: names });
      const db = await new Promise((res) => { const q = indexedDB.open(dbName); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      if (!db || !db.objectStoreNames.contains('conversations')) return JSON.stringify({ found: false, why: 'no conversations store', dbs: names });
      const all = await new Promise((res) => { const q = db.transaction('conversations', 'readonly').objectStore('conversations').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
      // THE PAIR ID NAMES BOTH SIDES, so the DM is identified by identity rather than by position.
      const hits = all.filter((c) => has(c.name, ${JSON.stringify(me)}) && has(c.name, ${JSON.stringify(peer)}));
      if (hits.length !== 1) return JSON.stringify({ found: false, why: hits.length + ' conversation(s) name both users', stored: all.length, dbs: names });
      const convo = hits[0];
      const wm = typeof convo.readWatermarks === 'string' ? JSON.parse(convo.readWatermarks) : (convo.readWatermarks || {});
      const msgs = await new Promise((res) => { const q = db.transaction('messages', 'readonly').objectStore('messages').index('byConversation').getAll(convo.id); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
      const at = (m) => Number(m.timestamp);
      const mine = Number(wm[${JSON.stringify(me)}] || 0);
      return JSON.stringify({
        found: true,
        convoId: convo.id,
        watermark: mine,
        peerWatermark: Number(wm[${JSON.stringify(peer)}] || 0),
        messages: msgs.length,
        newest: msgs.length ? Math.max.apply(null, msgs.map(at)) : 0,
        pastWatermark: msgs.filter((m) => at(m) > mine).length,
      });
    })()`
  );
  return JSON.parse(raw);
}

/** Polls `fn` until it returns true, and answers with how long that took - or null. */
async function reaches(fn, timeoutMs = CROSS_DEVICE_MS, everyMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - t0;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(everyMs);
  }
}

/**
 * MULTI-1 - a message sent from W1 shows up on A1 as the account's OWN message.
 *
 * The failure this exists for is not a loss. The frame arrives, the text is right, and the sibling
 * device draws it as an incoming message from a stranger with an avatar beside it - which is what a
 * client does when it cannot recognise its own account as the sender. So the assertion is authorship
 * and nothing else; delivery is MSG's subject and is only the premise here.
 *
 * IT IS A DM AND NOT THE CHANNEL, deliberately: in a DM the product renders no sender name at all
 * (`showSender` is false for a direct conversation), so authorship reaches the DOM through exactly
 * one bit and there is no caption to read instead of it.
 */
async function multi1() {
  const [w1, o1] = await observed(PORTS.W1, 'MULTI-W1');
  const [a1, oA1] = await observed(PORTS.A1, 'MULTI-A1', { focus: false, match: 'tauri.localhost' });
  const since = Date.now();
  try {
    await ensureChat(w1);
    await ensureChat(a1);
    await ensureConversation(w1, PEER_NAME);
    await ensureConversation(a1, PEER_NAME);

    const m = mark('MULTI1');
    await send(w1, `${m} sent from the web device`);
    // ON THE SIBLING, not on the sender: a sender always draws its own message as its own, so
    // asserting on W1 would pass with the defect present.
    await awaitMessage(a1, m, CROSS_DEVICE_MS);
    const seen = JSON.parse(await evaluate(a1, OWNERSHIP(m)));
    const copies = await countMessage(a1, m);

    const verdict = !seen.hookPresent ? 'VACUOUS' : seen.own === 'true' && copies === 1 ? 'PASS' : 'FAIL';
    const gated = gate(verdict, {
      W1: ignoringStrandedMentions(await report(o1)),
      A1: await report(oA1),
      'A1-native': logcatReport(await logcatSince(since), 'A1-native'),
    });
    await record('MULTI-1', gated.verdict, {
      ...gated.detail,
      marker: m,
      // THE REASON A VACUOUS IS A VACUOUS, on the row, so nobody re-derives it from the source.
      hook: seen.hookPresent ? '[data-own] present' : '[data-own] absent - the surface this row reads is not in the deployed build',
      ownOnSibling: seen.own,
      rowsCarryingMarker: seen.rows,
      copiesOnSibling: copies,
    });
    return gated.verdict === 'PASS';
  } finally {
    w1.close();
    a1.close();
  }
}

/**
 * MULTI-2 - a read performed on A1 clears the unread the same account holds on W1.
 *
 * W1 NEVER OPENS THE CONVERSATION, and that is the whole check. `lookAway` puts it on a pane
 * holding nothing, so any clearing W1 does is something it LEARNT, never something it did: a check
 * that left the DM open on W1 would watch W1 mark its own messages read and call that a cross-device
 * sync.
 *
 * The zero is read from the STORE rather than from the badge. The badge is absent both when the count
 * is zero and when the tile is not rendered, and one of those is a check reading the wrong thing.
 */
async function multi2() {
  const [w1, o1] = await observed(PORTS.W1, 'MULTI-W1');
  const [w2, o2] = await observed(PORTS.W2, 'MULTI-W2');
  const [a1, oA1] = await observed(PORTS.A1, 'MULTI-A1', { focus: false, match: 'tauri.localhost' });
  const since = Date.now();
  try {
    await ensureChat(w1);
    await ensureChat(w2);
    await ensureChat(a1);

    // BOTH OF THE ACCOUNT'S DEVICES LOOK AWAY FIRST, or the unread never accrues to be cleared.
    //
    // AND THE ANSWER IS THE POINT, WHICH IS WHY THIS IS `lookAway` AND NOT `parkConversation`.
    // This row used to call the latter on both devices and drop what it said. On the PHONE that is
    // enough - mobile carries a back control - but on W1 the desktop layout has none, so the park
    // returned "this layout offers no back control", changed nothing, and left W1 sitting IN the
    // conversation it is supposed to be accruing an unread for. Asserting the answer turned that
    // into a visible ERROR on 2026-09-07 instead of a verdict about the product; `lookAway` is the
    // remedy `parkConversation`'s own docblock prescribes, for both layouts.
    await ensureConversation(w2, OWNER_NAME);
    const awayW1 = await lookAway(w1);
    const awayA1 = await lookAway(a1);
    await sleep(2000);

    // WHO EACH CLIENT IS, FROM ITS OWN STORAGE - the DM is addressed by the two user ids, and a row
    // that guessed at a display name is what made this check unmeasurable. `whoIs` reads the same
    // `mls_device_id_<user>` key the app writes, so no name, login or fixture is involved.
    const meWho = await whoIs(w1);
    const peerWho = await whoIs(w2);
    if (!meWho || !peerWho) {
      await recordObserved(
        'MULTI-2',
        'ERROR',
        { why: `a client holds no identity - W1=${!!meWho} W2=${!!peerWho}` },
        { W1: o1, W2: o2, A1: oA1 }
      );
      return false;
    }

    const before = await dmReadState(w1, meWho.user, peerWho.user);
    if (!before.found) {
      await recordObserved(
        'MULTI-2',
        'VACUOUS',
        { why: `W1 holds no single DM naming both users: ${before.why}`, seen: before },
        { W1: o1, W2: o2, A1: oA1 }
      );
      return false;
    }

    const m = mark('MULTI2');
    await send(w2, `${m} one`);
    await send(w2, `${m} two`);

    // UNREAD ACCRUES AS MESSAGES PAST W1'S OWN WATERMARK, which is what the product derives the
    // badge from. Two were sent, so two is the floor; a third from anything else in flight would not
    // make this reading wrong.
    const accruedMs = await reaches(async () => (await dmReadState(w1, meWho.user, peerWho.user)).pastWatermark >= 2);
    const armed = await dmReadState(w1, meWho.user, peerWho.user);

    // THE READ, ON THE OTHER DEVICE.
    await ensureConversation(a1, PEER_NAME);
    await awaitMessage(a1, m, CROSS_DEVICE_MS);
    const clearedMs = await reaches(async () => (await dmReadState(w1, meWho.user, peerWho.user)).pastWatermark === 0);
    const after = await dmReadState(w1, meWho.user, peerWho.user);

    // W1 MUST STILL BE LOOKING AWAY. If something navigated it into the conversation, the clearing
    // proves nothing and the run has to say so rather than bank the pass.
    //
    // READ FROM THE PANE, NEVER FROM THE BODY - this guard was fault #29 running backwards. It asked
    // `document.body.innerText.indexOf(marker) === -1`, and `SAMPLE`'s own docblock in `chat.mjs`
    // says what that reads: "a marker in the body but not in the pane is the sidebar preview of a
    // conversation nobody opened". A parked client shows the newest message as its tile's SUBTITLE,
    // so the body contained the marker exactly BECAUSE W1 had stayed outside - and the row recorded
    // FAIL on 2026-09-07 with all three of its real measurements holding (accrued 2 in 1020 ms,
    // cleared in 2032 ms, watermark advanced). The same text in two places means two opposite things
    // and only the pane distinguishes them.
    //
    // BOTH HALVES, because they refute different accidents: `PANE_STATE` says no conversation is
    // open at all, which is the state `lookAway` established, and the pane count says the
    // marker is not being rendered as a message even if something re-opened something.
    const paneState = await evaluate(w1, PANE_STATE);
    const inPane = await countMessage(w1, m);
    const w1StillParked = paneState === 'nothing' && inPane === 0;

    const ok = accruedMs !== null && clearedMs !== null && w1StillParked === true;
    const gated = gate(ok ? 'PASS' : 'FAIL', {
      W1: ignoringStrandedMentions(await report(o1)),
      W2: ignoringStrandedMentions(await report(o2)),
      A1: await report(oA1),
      'A1-native': logcatReport(await logcatSince(since), 'A1-native'),
    });
    await record('MULTI-2', gated.verdict, {
      ...gated.detail,
      marker: m,
      unreadAccruedInMs: accruedMs,
      unreadWhenArmed: armed.pastWatermark,
      watermarkWhenArmed: armed.watermark,
      readOnSiblingClearedInMs: clearedMs,
      unreadAfter: after.pastWatermark,
      watermarkAfter: after.watermark,
      watermarkAdvanced: after.watermark > armed.watermark,
      w1NeverOpenedIt: w1StillParked,
      w1PaneState: paneState,
      w1MarkerInPane: inPane,
      lookedAway: { W1: awayW1, A1: awayA1 },
    });
    return gated.verdict === 'PASS';
  } finally {
    w1.close();
    w2.close();
    a1.close();
  }
}

/**
 * MULTI-5 - two tabs of W1 and A1, all three on one channel, one message from the peer.
 *
 * THE SIBLING TAB IS A SECOND MLS CLIENT, which is why `client()` refuses an ambiguous browser at
 * all, and why every exit path below closes it. A tab left behind is charged to whatever runs next as
 * a fault it did not cause - see `tabs.mjs`.
 *
 * The sibling is opened at `/chat?tab=2` so the two are TELLABLE APART. `client()` picks `hits[0]`,
 * which is a POSITION, and two tabs on the same URL would make "which tab am I driving" a coin toss;
 * a query the SPA ignores costs nothing and turns the match into an identity.
 *
 * WHAT IT ASSERTS is one copy on each of the three, and each client's own observation clean - the
 * second half being where a socket kicked out by its sibling would show. Three clients of one account
 * sharing one epoch is precisely the shape that used to cost one of them its connection.
 */
async function multi5() {
  const [w1, o1] = await observed(PORTS.W1, 'MULTI-W1a');
  const [w2, o2] = await observed(PORTS.W2, 'MULTI-W2');
  const [a1, oA1] = await observed(PORTS.A1, 'MULTI-A1', { focus: false, match: 'tauri.localhost' });
  const since = Date.now();

  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORTS.W1}/json/version`)).json();
  const browser = connect(webSocketDebuggerUrl);
  await browser.ready;
  let w1b = null;
  let o1b = null;
  try {
    await browser.send('Target.createTarget', { url: `${SITE}/chat?tab=2`, newWindow: false });
    await sleep(4000);
    [w1b, o1b] = await observed(PORTS.W1, 'MULTI-W1b', { match: '/chat?tab=2', allowMany: true, focus: false });

    // THE SIBLING IS A NEW DOCUMENT, SO IT COMES UP AT THE PIN GATE, and until 2026-09-07 this row
    // clicked straight through it. `Target.createTarget` boots the SPA from nothing - the unlocked
    // key lives in the ORIGINAL document, not on the profile - so the gate is up and every selector
    // below is aimed at a page a modal is covering. That is exactly what MULTI-5's `ERROR` was:
    // `realClick` on `a[href="/communities"]` with `dialogsOpen: ["PIN de chiffrement"]` and
    // `onTopAtOwnCentre: false`, which is the RIG's unarmed precondition wearing the shape of a
    // navigation defect.
    //
    // AND IT IS ASSERTED, NOT ATTEMPTED. A client left at the gate renders, answers every probe and
    // reports on an EMPTY store, so `countMessage(w1b)` would return 0 and the row would charge the
    // application for a copy the sibling was never in a position to receive - the failure mode
    // `pingate` was extracted to end.
    const gateW1b = await unlockClient(w1b, PORTS.W1, ACCOUNT_OF.W1, { match: '/chat?tab=2' });
    if (gateW1b.verdict !== 'unlocked') {
      throw new Error(`the sibling tab did not come back from the PIN gate: ${gateW1b.verdict} (${gateW1b.said})`);
    }

    await openChannel(w1);
    await openChannel(w1b);
    await openChannel(a1);
    await openChannel(w2);
    await sleep(2000);

    const m = mark('MULTI5');
    await send(w2, `${m} to three clients of one account`);

    const copies = {};
    for (const [label, cx] of [
      ['w1a', w1],
      ['w1b', w1b],
      ['a1', a1],
    ]) {
      await awaitMessage(cx, m, CROSS_DEVICE_MS).catch(() => {});
      copies[label] = await countMessage(cx, m);
    }

    // THE SECOND TAB'S OWN CONSEQUENCES, FORGIVEN ON THIS ROW AND NOWHERE ELSE.
    //
    // The classifier leaves `[TAB] Another tab is active` UNCLASSIFIED on purpose: a tab that
    // genuinely LOST an election emits it too, and its absence beside a skipped flush is exactly
    // what identified the boot gap it documents. So it must keep breaking `clean` everywhere - and
    // this row is the one place where a follower tab is the PREMISE rather than a finding, which is
    // what `ignoringExpectedLog` is for: per row, named, never a wider classifier.
    //
    // THE SNAPSHOT COLLISION IS THE SAME CASE, and the product says so in `hex.ts`: two writers
    // seeded from one stored version reach the same number, the write is dropped, and "TAB-4 (two
    // tabs of one client) makes the equality case fire on an ordinary run". Whether dropping the
    // second tab's write can lose state is a real question and is ALREADY P2 in `backlog.md`; it is
    // forgiven here as expected FOR A TWO-TAB ROW, not answered.
    const SIBLING_PREMISE = [
      '[TAB] Another tab is active - read-only mode',
      '[TAB] Follower tab - WebSocket active in another Canari tab',
      '[TAB] Follower tab - skipping initializeConnection',
    ];
    const repW1b = ignoringStrandedMentions(ignoringExpectedLog(await report(o1b), [
      ...SIBLING_PREMISE,
      // A fresh document boots MLS; expected, but NOT required - a sibling that reused a warm
      // worker would not print it and would still be a sibling.
      'Initialising MLS...',
    ]));
    const repW1a = ignoringStrandedMentions(
      ignoringExpectedLog(await report(o1), [
        '[OUTBOX] Flush requested by a follower tab',
        'collides with the stored one - another writer reached this version from the same seed',
      ])
    );

    // AND THE PREMISE IS ASSERTED, NOT MERELY FORGIVEN. `ignoringExpectedLog` reports the needles
    // that matched NOTHING, and its own docblock says why that has to be read: a dry needle for a
    // line the check's premise requires is a check measuring nothing at all. If the sibling never
    // announced itself a follower, this row is three clients of one account only on paper - the two
    // tabs would be two leaders, which is a different test with a different meaning.
    const premiseMissing = SIBLING_PREMISE.filter((n) =>
      repW1b.ignoredAsExpectedLog.unmatched.includes(String(n))
    );

    const ok =
      copies.w1a === 1 &&
      copies.w1b === 1 &&
      copies.a1 === 1 &&
      premiseMissing.length === 0;
    const gated = gate(ok ? 'PASS' : 'FAIL', {
      W1a: repW1a,
      W1b: repW1b,
      W2: ignoringStrandedMentions(await report(o2)),
      A1: await report(oA1),
      'A1-native': logcatReport(await logcatSince(since), 'A1-native'),
    });
    await record('MULTI-5', gated.verdict, {
      ...gated.detail,
      marker: m,
      copies,
      siblingWasAFollower: premiseMissing.length === 0,
      premiseMissing,
    });
    return gated.verdict === 'PASS';
  } finally {
    // THE SIBLING GOES, WHATEVER HAPPENED. Everything above can throw, and a throw between the
    // create and here leaves a second MLS client on the profile for the next phase to trip over.
    if (w1b) w1b.close();
    const closed = await closeExtraAppTabs(PORTS.W1).catch((e) => `failed: ${e.message}`);
    console.log(`[MULTI-5] sibling teardown closed ${closed} extra tab(s)`);
    try {
      browser.close();
    } catch {
      /* the browser connection dying on the way out is not a finding */
    }
    w1.close();
    w2.close();
    a1.close();
  }
}

/**
 * MULTI-6 - A1 is dead across twenty sends, then comes back.
 *
 * THE POINT IS THE TAIL, NOT THE FIRST MESSAGE. A device that returns and picks up one of twenty has
 * converged on nothing, and a device that picks up twenty in the wrong order has converged on
 * something a user cannot read. So the row asserts three things over one burst: every marker present,
 * each exactly once, and their order preserved.
 *
 * IT STAYS DEAD FOR A WHILE ON PURPOSE. `OFFLINE_MS` is not a heartbeat and nothing is asserted about
 * it - it exists so the twenty frames AGE in the queue rather than being handed to a device that was
 * never really gone. A check whose device is down for 200 ms measures a reconnect, not an absence.
 */
async function multi6() {
  const [w2, o2] = await observed(PORTS.W2, 'MULTI-W2');
  let a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
  const since = Date.now();
  try {
    await ensureChat(a1);
    await ensureConversation(a1, PEER_NAME);
    await ensureChat(w2);
    await ensureConversation(w2, OWNER_NAME);

    phone.clearLogcat();
    a1.close();
    a1 = null;
    const death = await phone.killAndProveDead();

    const m = mark('MULTI6');
    for (let i = 1; i <= BURST; i++) await send(w2, `${m} #${String(i).padStart(2, '0')}`);
    // PROVEN TO HAVE LEFT THE SENDER before the phone is woken - otherwise a phone that receives
    // nothing would be indistinguishable from a burst that was never sent.
    await awaitMessage(w2, `${m} #${String(BURST).padStart(2, '0')}`, CROSS_DEVICE_MS);
    await sleep(OFFLINE_MS);

    // COLD START: launch, forward, attach, unlock, and only then `ensureChat` - a restarted app opens
    // on its default route, never where it was. See `del.mjs`, which learnt each of those four.
    phone.launch();
    await sleep(6000);
    phone.forwardDevtools(PORTS.A1);
    await sleep(2000);
    a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
    const oA1 = await watch(a1, 'MULTI-A1');
    const unlock = phone.unlockPin(PORTS.A1);
    await ensureChat(a1);
    await ensureConversation(a1, PEER_NAME);

    const label = (i) => `${m} #${String(i).padStart(2, '0')}`;
    const arrivedInMs = await reaches(
      async () => (await countMessage(a1, label(BURST))) >= 1,
      CROSS_DEVICE_MS * 3
    );

    const counts = {};
    for (let i = 1; i <= BURST; i++) counts[i] = await countMessage(a1, label(i));
    const missing = Object.entries(counts).filter(([, c]) => c === 0).map(([i]) => Number(i));
    const duplicated = Object.entries(counts).filter(([, c]) => c > 1).map(([i]) => Number(i));

    // ORDER, READ OFF THE PANE ITSELF. The index of each marker in the rendered text must ascend;
    // anything else is twenty messages a user cannot follow.
    const positions = JSON.parse(
      await evaluate(
        a1,
        `JSON.stringify([${Array.from({ length: BURST }, (_, i) => JSON.stringify(label(i + 1))).join(',')}]
          .map(function (s) { return document.body.innerText.indexOf(s); }))`
      )
    );
    const ordered = positions.every((p, i) => p !== -1 && (i === 0 || p > positions[i - 1]));

    const ok = missing.length === 0 && duplicated.length === 0 && ordered;
    // THE PHONE DIED AND CAME BACK, WHICH IS THIS ROW'S PREMISE AND NOT A FINDING. A device woken
    // after 60 s dead boots MLS, re-registers with FCM and pre-injects what the push cache held; the
    // native half then hands each waiting push to the foreground that has taken the MLS state. Every
    // one of those lines must keep breaking `clean` for a row that did NOT ask for a cold boot,
    // which is why `PHONE_COLD_BOOT` is a constant this row NAMES rather than a classifier rule.
    //
    // The duplicate-ignored lines are `notable`, which never broke `clean` - and they are the fix
    // working: the WS catch-up and the FCM cache legitimately overlap, and the ingest says so.
    const gated = gate(ok ? 'PASS' : 'FAIL', {
      W2: ignoringStrandedMentions(await report(o2)),
      A1: ignoringExpectedLog(await report(oA1), PHONE_COLD_BOOT),
      'A1-native': ignoringExpectedLog(
        logcatReport(await logcatSince(since), 'A1-native'),
        PHONE_COLD_BOOT
      ),
    });
    await record('MULTI-6', gated.verdict, {
      ...gated.detail,
      marker: m,
      sent: BURST,
      deadInMs: death.deadInMs,
      keptDownMs: OFFLINE_MS,
      pinPromptOnWake: unlock,
      lastArrivedInMs: arrivedInMs,
      missing,
      duplicated,
      ordered,
    });
    return gated.verdict === 'PASS';
  } finally {
    w2.close();
    if (a1) a1.close();
  }
}

// THE TWO THAT CANNOT BE AUTOMATED ARE RECORDED, NOT OMITTED - see the header for each reason.
const HUMAN = {
  3: 'a device enrolled after the fact does not exist, and a first login on a new device is SETUP-4 2FA - a one-off human action',
  4: 'this IS device check L (WP-DEV-PANEL-1) in device-verification.md, owed on hardware, and the revoke costs A1 its enrolment',
};

const CHECKS = { 1: multi1, 2: multi2, 5: multi5, 6: multi6 };

const results = [];
for (const [n, why] of Object.entries(HUMAN)) {
  if (only !== null && Number(n) !== only) continue;
  record(`MULTI-${n}`, 'SKIPPED', { why });
  results.push([n, true]);
}
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    // THE FRAME, NOT JUST THE SENTENCE. `Cannot convert undefined or null to object` names no call
    // site, and this phase produced three of them on its first ever run (2026-08-27) with nothing to
    // say which of its own reads had returned null - the message was the whole record, so the only
    // way to place it was to re-run by hand. An ERROR is the one verdict that cannot describe what
    // it measured, so it owes the stack instead.
    record(`MULTI-${n}`, 'ERROR', {
      ...errorDetail(e),
      // NOT `at`: that is the LEDGER's own timestamp field, and `record` spreads the detail OVER it,
      // so a stack put there erases the time the row was written - which is what filters a run's
      // verdicts. Two rows were corrupted that way on 2026-08-27 before the collision was seen.
      stack: String(e.stack ?? '')
        .split(/\r?\n/)
        .slice(1, 5)
        .map((l) => l.trim())
        .join(' <- '),
    });
    results.push([n, false]);
  }
}
console.log(`\nMULTI: ${results.filter(([, ok]) => ok).length}/${results.length} assertions held`);
// NO EXIT CODE DERIVED FROM THESE BOOLEANS - `results.mjs` derives it from the recorded verdicts,
// which are the GATED ones. `grp.mjs`, `del.mjs` and `search.mjs` carry the same note for its reason.

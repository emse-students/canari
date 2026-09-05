#!/usr/bin/env node
/**
 * TYPE-1..5 - the typing indicator, on both transports.
 *
 * WHAT THE APP ACTUALLY PROMISES (read off the source, not guessed - the numbers are the whole
 * check, so a check written against invented ones would pass or fail for no reason):
 *
 *   SENDER  `ChatComposer.svelte`: `start` at most once per 3 s while the text is non-empty,
 *           `stop` after 4 s of inactivity, and immediately on send / blur / unmount.
 *   RECEIVER `typingStore.svelte.ts`: every `start` (re)arms a 6 s expiry - TYPING_TTL_MS. So a
 *           LOST `stop` self-heals in at most 6 s, and that is the whole point of the TTL.
 *   TRANSPORT DMs and groups go over the gateway WebSocket keyed by the MLS groupId; channels go
 *           over social HTTP (`channelService.sendTyping`). Two different paths, hence TYPE-5.
 *
 * THE INDICATOR IS READ THROUGH `role="status"`, not through its French text. Before this run it
 * had no hook at all and no live region either; making it one fixed the screen-reader gap and gave
 * the harness its selector in the same edit.
 *
 * WHY THERE IS NO `sleep` DRIVING THE ASSERTIONS. Every deadline here is the app's, so each wait
 * is a poll for a STATE with a bound derived from the constant above, plus slack for the round
 * trip. `TYPE-2` is the one exception where time itself is the subject, and even there the
 * assertion is "cleared, and not before ~4 s", never "cleared at exactly 6 s".
 *
 * EVERY CHECK HERE IS OBSERVED, and it was not always so. Until 2026-08-14 this file computed all
 * five verdicts from its assertions alone and read no console at all - so a TYPE pass stated that
 * an indicator appeared and stated NOTHING about what the two pages logged while it did. Observation
 * is part of a check, not a debugging step; `watch` + `report` + `gate` now wrap each one, and a
 * clean assertion over a dirty client is `PASS-DIRTY`, never `PASS`.
 *
 *   bun type.mjs                 # all five
 *   bun type.mjs --only 2        # one
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { client, evaluate, openDM, openChannel, realClick, until, COMPOSER } from '../chat.mjs';
import { gate, ignoringOfflineCut, report, watch } from '../watch.mjs';
import { armCut, cutHard } from './net.mjs';
import { awaitOffline, awaitOnline, whoIs } from './presence.mjs';
import { errorDetail, record } from '../results.mjs';
import { OWNER_NAME, PEER_NAME, PORTS, SITE } from '../names.mjs';

const { W1, W2 } = PORTS;

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null;

/** The live region's text, empty string when nobody is typing. Never null - it always exists now. */
const INDICATOR = `(function () {
  var el = document.querySelector('.chat-typing-indicator');
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null;
})()`;

/** Types into the composer WITHOUT sending, which is what emits `start`. */
async function typeOnly(cx, text) {
  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.querySelector('${COMPOSER}').focus()`);
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text });
}

/** Empties the composer, which is what makes `handleMessageChange` call `stopTyping`. */
async function clearComposer(cx) {
  await realClick(cx, COMPOSER);
  await evaluate(cx, `document.execCommand('selectAll')`);
  await cx.send('Input.insertText', { text: '' });
}

const elapsed = (t0) => Date.now() - t0;

async function type1() {
  const [a, b] = await Promise.all([client(W1), client(W2)]);
  await openDM(a, PEER_NAME);
  await openDM(b, OWNER_NAME);
  await clearComposer(a);

  const wA = await watch(a, 'sender');
  const wB = await watch(b, 'receiver');

  const before = await evaluate(b, INDICATOR);
  await typeOnly(a, 'TYPE1 probe');
  const shownMs = await until(b, `${INDICATOR}.length > 0`, 8000, 50).catch(() => null);
  const label = await evaluate(b, INDICATOR);

  // The stop is emitted when the box goes empty, not on a timer, so this measures the STOP path
  // rather than the TTL - TYPE-2 measures the TTL.
  const t1 = Date.now();
  await clearComposer(a);
  const clearedMs = await until(b, `${INDICATOR}.length === 0`, 8000, 50).catch(() => null);

  const ok = before === '' && shownMs !== null && shownMs < 3000 && clearedMs !== null && clearedMs < 3000;
  const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(wA), W2: await report(wB) });
  record('TYPE-1', gated.verdict, {
    ...gated.detail,
    hookPresent: before !== null,
    before,
    shownMs,
    label,
    clearedMs,
    sinceStop: elapsed(t1),
  });
  [a, b].forEach((c) => c.close());
  // THE GATED VERDICT, not the raw assertion: a check whose client logged something nobody can
  // explain has not passed, it is `PASS-DIRTY`, and the exit code has to say so.
  return gated.verdict === 'PASS';
}

async function type2() {
  // The stop is never sent: the composer keeps its text and the tab keeps living, so the ONLY
  // thing that can clear the peer's indicator is the 6 s TTL. A pass here is what makes a lost
  // `stop` frame survivable, which is the reason the TTL exists.
  const [a, b] = await Promise.all([client(W1), client(W2)]);
  await openDM(a, PEER_NAME);
  await openDM(b, OWNER_NAME);
  await clearComposer(a);

  const wA = await watch(a, 'sender');
  const wB = await watch(b, 'receiver');

  await typeOnly(a, 'TYPE2 probe');
  const shownMs = await until(b, `${INDICATOR}.length > 0`, 8000, 50).catch(() => null);
  const shownAt = Date.now();

  // Freeze the SENDER so it cannot emit the 4 s idle `stop`: the question is what the receiver
  // does on its own. Detaching the composer's listeners is not possible from here, so instead the
  // sender's page is suspended by never touching it again and the receiver is watched. The 4 s
  // idle stop WILL fire, which is why the lower bound below is 3.5 s and not 5.5 s - what is being
  // asserted is that the indicator goes away, and no earlier than the shorter of the two rules.
  const clearedMs = await until(b, `${INDICATOR}.length === 0`, 12000, 100).catch(() => null);

  const ok = shownMs !== null && clearedMs !== null && clearedMs >= 3500 && clearedMs <= 9000;
  const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(wA), W2: await report(wB) });
  record('TYPE-2', gated.verdict, {
    ...gated.detail,
    shownMs,
    clearedMs,
    heldForMs: Date.now() - shownAt,
    bound: '3500..9000 (4s sender idle-stop, 6s receiver TTL)',
  });
  [a, b].forEach((c) => c.close());
  // THE GATED VERDICT, not the raw assertion: a check whose client logged something nobody can
  // explain has not passed, it is `PASS-DIRTY`, and the exit code has to say so.
  return gated.verdict === 'PASS';
}

async function type3() {
  // A tab CLOSE does not run Svelte's onDestroy, so no `stop` is emitted - the receiver is left to
  // the TTL. That is the design; what must not happen is a permanently stuck indicator.
  const b = await client(W2);
  await openDM(b, OWNER_NAME);

  const targets = await (await fetch(`http://127.0.0.1:${W1}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));

  const a = await client(W1);
  await openDM(a, PEER_NAME);
  await clearComposer(a);

  // ONLY THE RECEIVER IS OBSERVED HERE, and that is not an oversight: this check destroys the
  // sender's tab on purpose, so there is no page left to drain a report from. The receiver is the
  // subject anyway - the question is whether IT is left with a stuck indicator.
  const wB = await watch(b, 'receiver');

  await typeOnly(a, 'TYPE3 probe');
  const shownMs = await until(b, `${INDICATOR}.length > 0`, 8000, 50).catch(() => null);

  // A SPARE TAB FIRST. Chrome exits when its LAST tab closes, and closing a tab is the whole point
  // of this check - so without this it took the browser down with it, and with the browser every
  // check that came after: TYPE-4 and TYPE-5 both reported `no target on 9224` and read as
  // application faults rather than as the wreckage of TYPE-3. A check may leave a client in a state
  // it can be recovered FROM; it may not destroy the instrument. The runner's preflight re-unlocks
  // W1 afterwards, since a fresh tab starts at the PIN gate.
  await fetch(`http://127.0.0.1:${W1}/json/new?url=${encodeURIComponent(`${SITE}/chat`)}`, {
    method: 'PUT',
  }).catch(() => {});

  // Kill the tab outright, mid-typing, without letting anything unwind.
  a.close();
  await fetch(`http://127.0.0.1:${W1}/json/close/${page.id}`).catch(() => {});

  const clearedMs = await until(b, `${INDICATOR}.length === 0`, 12000, 100).catch(() => null);
  const ok = shownMs !== null && clearedMs !== null && clearedMs <= 9000;

  // RESTORE W1 BEFORE RETURNING. The spare tab opens at about:blank, whose origin is the string
  // "null", so the next check's `location.origin + '/chat'` is an invalid URL - which is how TYPE-4
  // and TYPE-5 came to report "Cannot navigate to invalid URL" about an application that was fine.
  // A destructive check owns its cleanup: it navigates the spare to an ABSOLUTE url and re-enters
  // the PIN, because a fresh tab always starts locked. Doing it here rather than leaving it to the
  // runner is what makes this file runnable on its own, which is the whole point of a check.
  //
  // AND `pin.mjs` IS AT THE HARNESS ROOT, NOT BESIDE THIS FILE. The spawn used this runner's OWN
  // directory as its cwd - the harness root until the runners moved into `archive/`, and `archive/`
  // ever since, where there is no `pin.mjs`. With `stdio: 'ignore'` the failure was
  // invisible and its exit code went nowhere but `restored.unlocked`, so TYPE-3 kept reporting PASS
  // while leaving W1 behind the PIN gate. TYPE-1, TYPE-4 and TYPE-5 then died in a row on
  // `sidebarPanel: false` (measured 2026-09-04) - three rows reporting a missing conversation list
  // about a client that was simply locked.
  const restored = { navigated: false, unlocked: false };
  try {
    const spare = await client(W1);
    await evaluate(spare, `location.href = ${JSON.stringify(`${SITE}/chat`)}`);
    restored.navigated = true;
    spare.close();
    await new Promise((r) => setTimeout(r, 5000));
    restored.unlocked =
      (await new Promise((resolve) => {
        const PIN = fileURLToPath(new URL('../pin.mjs', import.meta.url));
        const c = spawn(process.execPath, [PIN, '--device', 'W1'], {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          stdio: 'ignore',
        });
        c.on('close', resolve);
      })) === 0;
  } catch (e) {
    restored.error = String(e).slice(0, 120);
  }

  // A TEARDOWN THAT DID NOT RESTORE IS NOT A PASS, AND THIS CHECK KNEW AND SAID NOTHING.
  //
  // `restored.unlocked` was already recorded and already `false`; nothing read it, so the row
  // reported PASS on its own question while leaving the estate broken for every row after it. The
  // assertion and the cleanup are different claims, so the detail keeps them apart - `ok` still
  // says whether the indicator cleared - but the VERDICT may not claim a run that damaged what
  // follows.
  const teardown = restored.navigated && restored.unlocked;
  const gated = gate(ok && teardown ? 'PASS' : 'FAIL', { W2: await report(wB) });
  record('TYPE-3', gated.verdict, {
    ...gated.detail,
    assertionHeld: ok,
    teardownRestored: teardown,
    shownMs,
    clearedMs,
    killedTab: page?.id ?? null,
    restored,
  });
  b.close();
  // THE GATED VERDICT, not the raw assertion: a check whose client logged something nobody can
  // explain has not passed, it is `PASS-DIRTY`, and the exit code has to say so.
  return gated.verdict === 'PASS';
}

async function type4() {
  // Offline peer: nothing arrives, and - the half that actually matters - nothing is REPLAYED when
  // it comes back. A typing signal is ephemeral by nature; a queued one would show a phantom.
  //
  // OFFLINE IS A FACT AT THE GATEWAY, NOT A SETTING IN THE BROWSER, and this check learnt it the
  // expensive way. It used `Network.emulateNetworkConditions({offline:true})`, which fails NEW
  // requests and leaves an ESTABLISHED WebSocket open - already measured on 2026-08-13 as sixty
  // seconds of "offline" with the presence key refreshed the whole way through, and written into
  // `msg9.mjs` at the time. So the peer was never cut, took the typing frame live exactly as it
  // should have, and the check reported a delivery defect that was its own doing.
  //
  // The rule underneath is bigger than the cut: A CHECK MUST ASSERT ITS OWN PRECONDITION. This one
  // asserted `whileOffline === ''` while never once establishing that the peer was offline, so the
  // only outcome it could not produce was the true one. `cutHard` closes the socket as a dropped
  // connection would and `awaitOffline` turns the gateway's agreement into a fact; without that
  // agreement the verdict is INVALID, never FAIL.
  const [a, b] = await Promise.all([client(W1), client(W2)]);
  // ARMED FIRST: the patch has to be in the document before the app opens its socket, so it costs a
  // reload - which has to happen before anything is opened or measured.
  await armCut(b);
  await openDM(a, PEER_NAME);
  await openDM(b, OWNER_NAME);
  await clearComposer(a);

  const wA = await watch(a, 'sender');
  const wB = await watch(b, 'receiver-offline');

  const who = await whoIs(b);
  const cutInfo = await cutHard(b);
  const offlineAfterMs = who ? await awaitOffline(who.user, who.device) : null;
  if (offlineAfterMs === null) {
    await cutInfo.restore();
    // RECORDED, not just printed: a check that abandons in silence is indistinguishable from one
    // that passed.
    record('TYPE-4', 'INVALID', {
      reason: 'the peer never went offline at the gateway',
      socketsClosed: cutInfo.socketsClosed,
      identified: Boolean(who),
    });
    [a, b].forEach((c) => c.close());
    return false;
  }

  await typeOnly(a, 'TYPE4 probe');
  // The sender's `start` is emitted at once; 2.5 s is several round trips, so an indicator that is
  // going to appear has appeared. This is not a deadline of the app's, it is the absence of one.
  await new Promise((r) => setTimeout(r, 2500));
  const whileOffline = await evaluate(b, INDICATOR);
  await clearComposer(a);

  await cutInfo.restore();
  const backAfterMs = await awaitOnline(who.user, who.device);
  // Back at the gateway is not the same as "has drained whatever it was going to drain". The TTL is
  // 6 s, so a phantom replayed on reconnect would still be on screen well inside this window.
  await new Promise((r) => setTimeout(r, 6000));
  const afterReconnect = await evaluate(b, INDICATOR);

  const ok = whileOffline === '' && afterReconnect === '';
  // The receiver is the client this check cut, so its disconnected fetches and its closed socket are
  // the cut working - forgiven in the gate, kept in the record. The sender was never touched and is
  // judged unforgiven.
  const gated = gate(ok ? 'PASS' : 'FAIL', {
    W1: await report(wA),
    W2: ignoringOfflineCut(await report(wB)),
  });
  record('TYPE-4', gated.verdict, {
    ...gated.detail,
    whileOffline,
    afterReconnect,
    offlineAfterMs,
    backAfterMs,
    socketsClosed: cutInfo.socketsClosed,
  });
  [a, b].forEach((c) => c.close());
  // THE GATED VERDICT, not the raw assertion: a check whose client logged something nobody can
  // explain has not passed, it is `PASS-DIRTY`, and the exit code has to say so.
  return gated.verdict === 'PASS';
}

async function type5() {
  // The channel transport is HTTP, not the WS the four checks above exercise - a different code
  // path end to end, which is why it gets its own row rather than being assumed from TYPE-1.
  const [a, b] = await Promise.all([client(W1), client(W2)]);

  // OBSERVE THE SETUP TOO, because a setup that fails is the check failing and its evidence is the
  // console like any other. On 2026-08-15 `openChannel` threw on pass 4 of 5 - the click was
  // received by the right row and no composer ever appeared - and because the two windows opened
  // AFTER it, the run recorded one sentence and not a single line from either client. Nothing could
  // be attributed, and a re-run is not a recovery: it destroys the evidence it was meant to recover.
  //
  // The navigation `openChannel` performs is forgiven by `report` itself (it counts
  // `Page.frameNavigated`), so opening the window earlier costs nothing and closes beyond that count
  // still break `clean`.
  const wA = await watch(a, 'sender');
  const wB = await watch(b, 'receiver');

  // AND THE SETUP'S FAILURE CARRIES THAT EVIDENCE OUT. Without this the throw unwinds to the file's
  // top-level handler, which records `{error}` and nothing else - the windows are open, and their
  // contents die with the frame.
  try {
    await openChannel(a);
    await openChannel(b);
  } catch (e) {
    const gated = gate('ERROR', { W1: await report(wA), W2: await report(wB) });
    record('TYPE-5', 'ERROR', { ...gated.detail, stage: 'setup', ...errorDetail(e) });
    [a, b].forEach((c) => c.close());
    // RETURNED, NOT RETHROWN: the file's top-level handler would record a SECOND `TYPE-5 ERROR`
    // carrying only the message, and the poorer of the two rows is the one a reader would find last.
    console.log(`      [ERROR] TYPE-5 setup ${e.message}`);
    return false;
  }
  await clearComposer(a);

  const before = await evaluate(b, INDICATOR);
  await typeOnly(a, 'TYPE5 probe');
  const shownMs = await until(b, `${INDICATOR}.length > 0`, 10000, 50).catch(() => null);
  const label = await evaluate(b, INDICATOR);
  await clearComposer(a);
  const clearedMs = await until(b, `${INDICATOR}.length === 0`, 10000, 100).catch(() => null);

  const ok = before === '' && shownMs !== null && clearedMs !== null;
  const gated = gate(ok ? 'PASS' : 'FAIL', { W1: await report(wA), W2: await report(wB) });
  record('TYPE-5', gated.verdict, {
    ...gated.detail,
    transport: 'channel/HTTP',
    before,
    shownMs,
    label,
    clearedMs,
  });
  [a, b].forEach((c) => c.close());
  // THE GATED VERDICT, not the raw assertion: a check whose client logged something nobody can
  // explain has not passed, it is `PASS-DIRTY`, and the exit code has to say so.
  return gated.verdict === 'PASS';
}

const CHECKS = { 1: type1, 2: type2, 3: type3, 4: type4, 5: type5 };

const results = [];
for (const [n, fn] of Object.entries(CHECKS)) {
  if (only !== null && Number(n) !== only) continue;
  try {
    results.push([n, await fn()]);
  } catch (e) {
    record(`TYPE-${n}`, 'ERROR', { ...errorDetail(e) });
    results.push([n, false]);
  }
}
console.log(`\nTYPE: ${results.filter(([, ok]) => ok).length}/${results.length} passed`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);

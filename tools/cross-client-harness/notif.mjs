/**
 * NOTIF-4 / NOTIF-9 / NOTIF-10 - the notification surface, one check per run.
 *
 * These three are the ones the LIFE phase did NOT already answer. NOTIF-1 and NOTIF-8 were measured
 * by LIFE-8 (`am kill`, decrypted text in 4.7 s) and LIFE-4 (doze, decrypted text in 4.6 s), so
 * re-running them here would only re-measure the same transition under another name.
 *
 * The app must be OUT of the foreground for any of this to mean anything, and `am force-stop` is
 * not available to us: a force-stopped package sits in Android's STOPPED state and the framework
 * cancels every FCM broadcast to it. So the kill is always `am kill` from HOME, asserted.
 *
 * Usage: node notif.mjs 4|9|10
 */
import { client, ensureChat, openConversation, countMessage, awaitMessage, send, evaluate, COMPOSER } from './chat.mjs';
import { watch, report } from './watch.mjs';
import { mark } from './results.mjs';
import * as phone from './phone.mjs';
import { execFileSync } from 'node:child_process';
import { ACCOUNT_OF, PORTS, peerNameFor } from './names.mjs';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\//, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = String(process.argv[2] || '4');

// Progress on stderr. A check that stalls silently is indistinguishable from a slow one, and this
// harness has already produced verdicts for actions that never happened - so every step announces
// itself and every step that can block carries its own deadline.
const T0 = Date.now();
const stage = (s) => console.error(`[${String((Date.now() - T0) / 1000).padStart(6)}s] ${s}`);
/** Rejects rather than hang: an unbounded await here freezes the whole run with no diagnostic. */
const withDeadline = (p, ms, what) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what} did not settle in ${ms}ms`)))]);

/** Polls until the app's process is gone; throws rather than let a no-op kill become a verdict. */
async function requireDead(what, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (phone.pid() === null) return Date.now() - t0;
    await sleep(1_000);
  }
  throw new Error(`${what} did not kill the app - pid ${phone.pid()} is still alive`);
}

/** HOME, then `am kill`, then prove it died. */
async function killPhone() {
  // No HOME and no sleep here any more: `phone.kill` establishes its own precondition (the process
  // must be CACHED, which HOME alone does not make it) and returns the state it killed from, so a
  // miss carries its own evidence instead of a bare "still alive".
  const stateAtKill = await phone.kill();
  const deadInMs = await requireDead(`am kill (state at kill: ${stateAtKill})`);
  return deadInMs;
}

/** How many of the phone's current notifications mention `needle`. */
const shadeHits = (needle) => phone.notifications().filter((n) => n.full.includes(needle)).length;

/** Waits for a notification carrying `needle` to DISAPPEAR; returns elapsed ms or null on timeout. */
async function awaitDismissal(needle, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (shadeHits(needle) === 0) return Date.now() - t0;
    await sleep(2_000);
  }
  return null;
}

/**
 * Unlocks the encryption PIN if the modal is up; returns what happened, never throws on "no modal".
 * Copied from `life.mjs` deliberately - the PIN is read by `pin.mjs` from `test-accounts.json` and
 * must never become an argument, so the only way to reuse it is to spawn it.
 *
 * NOTIF-10 needed this and did not have it: cutting the radios for ten minutes restarts the app when
 * they come back, and a restarted app re-locks the PIN. The whole chat then sits behind the modal,
 * so `openConversation` cannot find anything and the check refused a verdict. Every phase that
 * relaunches the app must unlock before it navigates.
 */
function unlock(port = PORTS.A1) {
  try {
    return execFileSync(
      process.execPath,
      ['pin.mjs', '--port', String(port), '--account', ACCOUNT_OF.A1, '--match', 'tauri.localhost'],
      { cwd: HERE, encoding: 'utf8', timeout: 120_000 }
    )
      .trim()
      .split('\n')
      .pop();
  } catch (e) {
    if (e.status === 2) return 'no modal';
    return `pin.mjs failed: ${String(e.stdout || e.message).slice(0, 200)}`;
  }
}

// ── the three clients ────────────────────────────────────────────────────────
stage('waking and launching the phone');
phone.wake();
phone.launch();
await sleep(4_000);
phone.forwardDevtools(PORTS.A1);
const a1Setup = await withDeadline(client(PORTS.A1, 'tauri.localhost'), 60_000, 'A1 attach');
stage(`A1 attached; unlock -> ${unlock()}`);
stage('A1 attached; opening the DM');
await withDeadline(ensureChat(a1Setup), 60_000, 'A1 ensureChat').catch(() => null);
await withDeadline(openConversation(a1Setup, peerNameFor('A1')), 90_000, 'A1 openConversation').catch(() => null);

stage('attaching W2');
const w2 = await withDeadline(client(9223, 'canari-emse.fr'), 60_000, 'W2 attach');
await withDeadline(ensureChat(w2), 60_000, 'W2 ensureChat');
await withDeadline(openConversation(w2, peerNameFor('W2')), 90_000, 'W2 openConversation');

// W1 is the OWNER's other device. It must sit on the chat list, NOT inside the DM: a browser already
// looking at the conversation reads it as it lands, which would dismiss the phone's notification
// before the check ever asserted it was there. NOTIF-4 then needs it to open that DM on cue, so
// the conversation is opened ONCE here to prove the row is reachable, then left.
stage('attaching W1');
const w1 = await withDeadline(client(9224, 'canari-emse.fr'), 60_000, 'W1 attach');
await withDeadline(ensureChat(w1), 60_000, 'W1 ensureChat');
await withDeadline(openConversation(w1, peerNameFor('W1')), 90_000, 'W1 openConversation (pre-flight)');
stage('W1 can reach the DM; parking it on the chat list');
await evaluate(w1, `history.pushState({}, '', '/chat'); dispatchEvent(new PopStateEvent('popstate'))`).catch(() => null);
await sleep(2_500);

phone.clearLogcat();
const oW2 = await watch(w2, `notif${which}-w2`);
const oW1 = await watch(w1, `notif${which}-w1`);
const out = { check: `NOTIF-${which}` };

if (which === '4') {
  // Cross-device dismissal: the phone notifies, the OTHER device of the same user reads, the
  // phone's notification must go. The two halves are asserted separately - a check that only
  // watched the shade empty out would pass on a phone that never notified at all.
  stage('killing the phone');
  out.killedInMs = await killPhone();
  const m = mark('NOTIF4');
  stage(`sending ${m}`);
  await send(w2, `${m} cross-device dismissal`);
  stage('waiting for the notification');
  out.notifiedInMs = await phone.awaitNotification(m, 60_000);
  out.shadeBefore = shadeHits(m);
  stage(`notified after ${out.notifiedInMs}ms; W1 now reads it`);

  // W1 reads it. Opening the conversation is what emits the read receipt - but ONLY if the window
  // reports focused and visible (MainChatPage.svelte:435). That gate is what made this check fail
  // twice before focus emulation existed, so it is asserted rather than assumed: a run where W1 is
  // not focused measures nothing about the product.
  await withDeadline(openConversation(w1, peerNameFor('W1')), 90_000, 'W1 openConversation');
  out.w1Focus = await evaluate(w1, `JSON.stringify({ hasFocus: document.hasFocus(), vis: document.visibilityState })`);
  stage(`W1 focus gate: ${out.w1Focus}`);
  if (!JSON.parse(out.w1Focus).hasFocus) throw new Error('W1 is not focused - it can never emit a read receipt');
  await awaitMessage(w1, m, 30_000).catch(() => null);
  // The receipt is debounced 2 s and then rides the outbox, so give it room before concluding.
  await sleep(6_000);
  out.readOnW1 = await countMessage(w1, m);
  stage(`W1 holds ${out.readOnW1} copy; waiting for the shade to clear`);

  out.dismissedInMs = await awaitDismissal(m, 90_000);
  stage(`dismissal: ${out.dismissedInMs}`);
  out.shadeAfter = shadeHits(m);
  out.verdict = out.notifiedInMs !== null && out.readOnW1 === 1 && out.dismissedInMs !== null ? 'PASS' : 'FAIL';
  out.marker = m;
} else if (which === '9') {
  // Two devices of one user, one message: the phone must raise exactly ONE notification for it,
  // and the browser must hold exactly one copy. The failure this is looking for is a second
  // notification for the same message - one per delivery path rather than one per message.
  // EVERY step here gets a stage. The first run of this branch stalled with the last line printed
  // being the shared setup's, which made a stall indistinguishable from a slow notification - the
  // exact failure mode the header of this file warns about, reproduced by omitting stages here.
  stage('killing the phone');
  out.killedInMs = await killPhone();
  const m = mark('NOTIF9');
  stage(`sending ${m}`);
  await send(w2, `${m} one message, two devices`);
  stage('waiting for the notification');
  out.notifiedInMs = await phone.awaitNotification(m, 60_000);
  // Settle: a duplicate raised by a second path arrives AFTER the first, so counting immediately
  // would report 1 for a phone that shows 2 a moment later.
  stage(`notified after ${out.notifiedInMs}ms; settling 20s before counting the shade`);
  await sleep(20_000);
  out.shadeCount = shadeHits(m);
  out.shade = phone.notifications().map((n) => `${n.title} | ${n.body}`.slice(0, 120));

  stage(`shade holds ${out.shadeCount}; opening the DM on W1`);
  await withDeadline(openConversation(w1, peerNameFor('W1')), 60_000, 'openConversation(W1)');
  stage('W1 in the DM; waiting for the message');
  await awaitMessage(w1, m, 30_000).catch(() => null);
  await sleep(2_000);
  out.onW1 = await countMessage(w1, m);
  stage(`W1 holds ${out.onW1}`);
  out.verdict = out.notifiedInMs !== null && out.shadeCount === 1 && out.onW1 === 1 ? 'PASS' : 'FAIL';
  out.marker = m;
} else if (which === '10') {
  // Five messages across a ten-minute outage. The question is not whether they arrive - LIFE-6
  // answered that for one message - but whether FCM's collapsing loses four of them, and whether
  // the shade then lies about how many there are.
  const OFFLINE_MS = Number(process.env.NOTIF10_OFFLINE_MS || 10 * 60_000);
  phone.home();
  await sleep(2_000);
  stage(`cutting the radios for ${Math.round(OFFLINE_MS/1000)}s`);
  phone.sh('svc wifi disable');
  phone.sh('svc data disable');
  out.offlineForMs = OFFLINE_MS;

  const markers = [];
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const m = mark(`NOTIF10-${i}`);
    markers.push(m);
    stage(`sending ${i + 1}/5 while the phone is dark`);
    await send(w2, `${m} sent while offline (${i + 1}/5)`);
    await sleep(20_000);
  }
  // Stay dark for the rest of the window; the collapse this is looking for happens at Google's
  // end while the device is unreachable, so the wait is the experiment.
  const remaining = OFFLINE_MS - (Date.now() - t0);
  if (remaining > 0) await sleep(remaining);

  stage('restoring the radios');
  phone.sh('svc wifi enable');
  phone.sh('svc data enable');
  phone.wake();
  const backAt = Date.now();

  // The shade first, while the app is still not in the foreground - opening it would clear them.
  out.notifiedInMs = await phone.awaitNotification(markers[markers.length - 1], 120_000);
  out.shadeHits = markers.map((m) => shadeHits(m));
  out.shade = phone.notifications().map((n) => `${n.title} | ${n.body}`.slice(0, 120));
  out.reconnectToShadeMs = out.notifiedInMs === null ? null : Date.now() - backAt;

  stage('relaunching the app and re-pointing devtools at the NEW pid');
  phone.launch();
  await sleep(6_000);
  phone.forwardDevtools(PORTS.A1);
  await sleep(2_000);
  const a1 = await client(PORTS.A1, 'tauri.localhost', { focus: false });
  // A ten-minute blackout restarts the app when the radios come back, and a restarted app re-locks
  // the encryption PIN - so the chat is behind the modal and nothing below it can be navigated to.
  out.unlock = unlock();
  stage(`unlock -> ${out.unlock}`);
  await ensureChat(a1).catch(() => null);
  await openConversation(a1, peerNameFor('A1')).catch((e) => stage(`openConversation: ${e.message}`));

  // POST-CONDITION, and the reason the first run of this check was worthless: both navigation calls
  // swallowed their failure, so when the app came back on `/posts` (a restarted process opens on its
  // default route, not where it was) the count ran against the FEED and reported 0/5 - which reads
  // as five lost messages and measures nothing at all. A marker cannot appear on a screen that does
  // not show messages. Assert the conversation is on screen, or refuse to produce a verdict.
  const screen = JSON.parse(
    await evaluate(a1, `JSON.stringify({ url: location.href, composer: !!document.querySelector('${COMPOSER}') })`)
  );
  out.a1Screen = screen;
  stage(`A1 screen: ${JSON.stringify(screen)}`);
  if (!screen.composer) throw new Error(`A1 is not in a conversation (${screen.url}) - the count would be fiction`);

  for (const m of markers) await awaitMessage(a1, m, 90_000).catch(() => null);
  await sleep(3_000);
  out.counts = [];
  for (const m of markers) out.counts.push(await countMessage(a1, m));
  out.verdict = out.counts.every((c) => c === 1) ? 'PASS' : 'FAIL';
  out.markers = markers;
} else {
  throw new Error(`unknown NOTIF check ${which}`);
}

// ── observation ──────────────────────────────────────────────────────────────
const phoneConsole = phone.console_();
out.phoneNotable = phoneConsole.filter((l) =>
  /\[KP\]|SecretReuse|out of bounds|LOST frame|silent ACK|Duplicate|error|failed|epoch|STUCK/i.test(l)
);
// The whole report, not just `notable`: a verdict is PASS only if the assertions hold AND the run
// is clean, and two shipped bugs came out of a passing check's noise.
const trim = (r) => ({
  clean: r.clean,
  errors: r.errors,
  exceptions: r.exceptions,
  badHttp: r.badHttp,
  wsEvents: r.wsEvents,
  notable: r.notable,
  unexplained: r.unexplained,
});
out.w2 = trim(await report(oW2));
out.w1 = trim(await report(oW1));
console.log(JSON.stringify(out, null, 2));

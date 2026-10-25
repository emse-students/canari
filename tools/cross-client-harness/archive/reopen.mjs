/**
 * A SEAT KILLED AND BROUGHT BACK - the two halves every KILL row is made of (`archive/kill.mjs`).
 *
 *   killSeat(seat, how)          tab | browser | swipe | force-stop; returns once the death is PROVEN
 *   reviveSeat(seat, how, label) the same seat's app again, unlocked, with a fresh `watch()`
 *
 * A KILL THAT CANNOT PROVE IT HAPPENED IS WORTHLESS (`launch.mjs` `killBrowser`, whose first version
 * killed nothing and reported success): a closed tab is proven by the browser no longer listing it, a
 * killed browser by its port going quiet, a killed app by its pid going away. A swipe that leaves the
 * process alive THROWS - the row's premise failed, and a "kill" that was a trip to the recents screen
 * would otherwise be judged as a recovery.
 *
 * REVIVAL IS THE USER'S PATH: a new tab on the app, the relaunched browser, the relaunched app - then
 * the PIN, because a new document boots at the gate (`archive/multi.mjs`, MULTI-5). The seat's
 * `cx` and `w` are REPLACED in place, so every later step and the invariant read the living page; the
 * dead page's observation is returned to the caller, which records it.
 */
import { connect, listTargets } from '../cdp.mjs';
import { APP_TAB, awaitAppReady, client } from '../chat.mjs';
import { armIfPhone } from '../device.mjs';
import { killBrowser, startBrowser } from '../launch.mjs';
import { SITE } from '../site.mjs';
import { watch } from '../watch.mjs';
import { unlockClient } from './pingate.mjs';

/** The ways a seat is killed, by the kind of seat each applies to. */
export const KILLS = { tab: 'browser', browser: 'browser', swipe: 'phone', 'force-stop': 'phone' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fact` until true, or throws `what` at the bound. */
async function proven(fact, what, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fact()) return Date.now() - t0;
    await sleep(250);
  }
  throw new Error(`${what} not proven within ${timeoutMs} ms`);
}

/** The browser-level CDP connection of the port a page is on. */
async function browserOf(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })).json();
  const b = connect(webSocketDebuggerUrl);
  await b.ready;
  return b;
}

const appTabs = async (port) => (await listTargets(port).catch(() => [])).filter((t) => t.type === 'page' && String(t.url).includes(APP_TAB));

/** The swipe from recents: the recents screen, then the app's card thrown upward. */
async function swipeFromRecents(phone) {
  phone.sh('input keyevent KEYCODE_APP_SWITCH');
  await sleep(1_500);
  const m = /(\d+)x(\d+)/.exec(phone.sh('wm size'));
  if (!m) throw new Error('swipe: `wm size` gave no screen size');
  const [w, h] = [Number(m[1]), Number(m[2])];
  phone.sh(`input swipe ${Math.round(w / 2)} ${Math.round(h * 0.55)} ${Math.round(w / 2)} ${Math.round(h * 0.08)} 180`);
}

/**
 * Kills one seat and proves it dead.
 *
 * @param {{target: object, cx: object}} seat an `openSeats` seat
 * @param {'tab'|'browser'|'swipe'|'force-stop'} how
 * @returns {Promise<{how: string, killedAt: string, deadInMs: number}>}
 */
export async function killSeat(seat, how) {
  const kind = KILLS[how];
  if (!kind) throw new Error(`killSeat: no kill named ${how} - known: ${Object.keys(KILLS).join(' ')}`);
  if ((kind === 'phone') !== !!seat.target.isPhone) throw new Error(`killSeat: ${how} is a ${kind} kill and ${seat.target.device} is not one`);
  const killedAt = new Date().toISOString();
  const { port } = seat.target;
  if (how === 'tab') {
    // `Target.closeTarget` from the BROWSER's connection: the page's own socket dies with it.
    const { targetInfo } = await seat.cx.send('Target.getTargetInfo');
    const b = await browserOf(port);
    try {
      await b.send('Target.closeTarget', { targetId: targetInfo.targetId });
    } finally {
      b.close();
    }
    seat.cx.close?.();
    return { how, killedAt, deadInMs: await proven(async () => (await appTabs(port)).length === 0, `the app tab on ${port} closed`, 10_000) };
  }
  if (how === 'browser') {
    seat.cx.close?.();
    return { how, killedAt, deadInMs: await killBrowser(seat.target.device.toLowerCase()) };
  }
  const phone = await import('../phone.mjs');
  // `useDevice` in `phone.mjs`: the kill lands on the phone this seat names.
  phone.useDevice(seat.target.device);
  if (how === 'swipe') await swipeFromRecents(phone);
  else phone.forceStop();
  seat.cx.close?.();
  return { how, killedAt, deadInMs: await proven(() => phone.pid() === null, `${seat.target.device}'s process gone after ${how}`, 15_000) };
}

/**
 * Brings the seat's app back the way a user does, clears the PIN gate, and replaces `seat.cx` and
 * `seat.w` in place.
 *
 * @returns {Promise<{readyMs: number|null, pin: string}>}
 */
export async function reviveSeat(seat, how, label) {
  const { target } = seat;
  const t0 = Date.now();
  let cx = null;
  if (KILLS[how] === 'phone') {
    // `ensure` launches a process that is gone and re-points the devtools forward at the NEW pid.
    await armIfPhone(target, label);
    cx = await client(target.port, null, { focus: false });
    const phone = await import('../phone.mjs');
    const pin = String(phone.unlockPin(target.port));
    if (pin.startsWith('pin.mjs failed')) throw new Error(`${target.device}: the relaunched app did not unlock (${pin.slice(0, 200)})`);
    seat.cx = cx;
    seat.w = await watch(cx, label);
    return { readyMs: Date.now() - t0, pin: pin.trim().split('\n').pop().slice(0, 120) };
  }
  if (how === 'browser') await startBrowser(target.device.toLowerCase());
  else {
    const b = await browserOf(target.port);
    try {
      await b.send('Target.createTarget', { url: `${SITE}/chat`, newWindow: false });
    } finally {
      b.close();
    }
  }
  // `client()` resolves a target by URL, and for a few hundred ms after it is asked for there is no page.
  for (let a = 0; a < 40 && !cx; a++) {
    cx = await client(target.port, APP_TAB, { focus: false }).catch(() => null);
    if (!cx) await sleep(500);
  }
  if (!cx) throw new Error(`${target.device}: no app tab came back on ${target.port}`);
  const readyMs = await awaitAppReady(cx, 60_000).then(
    () => Date.now() - t0,
    () => null
  );
  const pin = await unlockClient(cx, target.port, target.account, { match: APP_TAB });
  if (pin.verdict !== 'unlocked') throw new Error(`${target.device}: the revived tab did not unlock (${pin.verdict}: ${pin.said})`);
  seat.cx = cx;
  seat.w = await watch(cx, label);
  return { readyMs, pin: pin.verdict };
}

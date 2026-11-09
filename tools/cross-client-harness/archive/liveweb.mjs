/**
 * LIVE-WEB-2 AND LIVE-STALL-1 - A LIVE FROM THE MI 9T, WATCHED FROM THE WEB, ONE ROW PER PROCESS.
 *
 *   bun run.mjs --file liveweb.mjs --row LIVE-WEB-2|LIVE-STALL-1
 *
 * Through `run.mjs`, always: the row names A1, so the preflight arms the phone and stamps its build
 * (`checks.mjs` `ROW_TABLES`). The table, the judges and the narration are `liverows.mjs`; this file
 * plays them. A1 opens the feed composer, takes the live chip, accepts the rules if asked and starts;
 * each viewer refreshes the feed until the card shows, opens it and plays; the viewers watch for the
 * row's `watchRounds`; A1 ends; each viewer must see the end. Then each viewer's own `[LIVE]` lines
 * are read IN ORDER for L-F1 (`stallsOf`).
 *
 * THE PHONE IS DRIVEN BY TAPS, NEVER BY A NAVIGATION: a page load re-locks the app behind its PIN.
 */
import { evaluate, goto, realClick } from '../chat.mjs';
import { confirmDialog } from '../comm.mjs';
import { srvLines } from '../estate.mjs';
import { LIVE_ROWS, ROUND_MS, liveNarration, liveOwn, liveRefusals, stallsOf } from '../liverows.mjs';
import { closeSeats, observersOf, openSeats } from '../mlsrow.mjs';
import { errorDetail, finishObserved, keepConsoles, record } from '../results.mjs';
import { consoleDump, consoleLines } from '../watch.mjs';

const argv = process.argv.slice(2);
const id = argv.includes('--row') ? argv[argv.indexOf('--row') + 1] : null;
if (!LIVE_ROWS[id]) {
  console.error(`usage: bun run.mjs --file liveweb.mjs --row ${Object.keys(LIVE_ROWS).join('|')}`);
  process.exit(2);
}
const spec = LIVE_ROWS[id];
const { by: B, viewers: VIEWERS } = spec;
const since = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${id}] ${msg}`);
let seats = null;
const cx = (d) => seats.seat[d].cx;
const ev = (d, js) => evaluate(cx(d), js);
const has = async (d, sel) => (await ev(d, `!!document.querySelector(${JSON.stringify(sel)})`)) === true;
const attr = (d, sel, a) => ev(d, `(document.querySelector(${JSON.stringify(sel)}) || {getAttribute(){return null}}).getAttribute(${JSON.stringify(a)})`);

/** The round a predicate first holds in, or `null` after `max` rounds of {@link ROUND_MS}. */
async function rounds(pred, max = 60) {
  for (let r = 1; r <= max; r++) {
    if (await pred()) return r;
    await sleep(ROUND_MS);
  }
  return null;
}

/** Taps the first visible element `find` (a JS predicate over `x`) selects; false when none shows. */
async function tapVisible(d, selector, find) {
  const tagged = await ev(d, `(() => { document.querySelectorAll('[data-rig-tap]').forEach((e) => e.removeAttribute('data-rig-tap')); const t = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getClientRects().length && (${find})); if (!t) return false; t.setAttribute('data-rig-tap', ''); return true; })()`);
  if (!tagged) return false;
  await realClick(cx(d), '[data-rig-tap]');
  return true;
}

/** In-app navigation: a page load on the web, a tap on the visible link on the phone. */
async function nav(d, path) {
  if (d !== 'A1') return goto(cx(d), path);
  if (!(await tapVisible(d, 'a', `x.getAttribute('href') === ${JSON.stringify(path)}`))) throw new Error(`A1: no visible link to ${path}`);
  return rounds(async () => (await ev(d, 'location.pathname')) === path, 20);
}

/** The feed's composer: `?compose=1` on the web, the Publier button on the phone. */
async function compose(d) {
  if (d !== 'A1') return goto(cx(d), '/posts?compose=1');
  // A composer already open (a previous attempt's) is the one used.
  if (await has(d, '[data-post-live]')) return;
  await nav(d, '/posts');
  if (!(await tapVisible(d, 'button,a', `/Publier/.test((x.innerText || '') + (x.getAttribute('aria-label') || ''))`))) throw new Error('A1: no visible Publier button on the feed');
}

const VIDEO = `(() => { const v = document.querySelector('[data-live-video]') || document.querySelector('[data-live-viewer] video'); if (!v) return null; const b = v.buffered; return { t: v.currentTime, paused: v.paused, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, ranges: b.length, end: b.length ? b.end(b.length - 1) : 0 }; })()`;

try {
  seats = await openSeats(spec.devices, id);
  // The viewers on the feed BEFORE the live, so nothing they show was loaded before it existed.
  for (const v of VIEWERS) await nav(v, '/posts');
  // A LIVE SCREEN LEFT OPEN by an earlier attempt is closed first - only from preview or ended,
  // where nothing is on air.
  if (await has(B, '[data-live-overlay]')) {
    const phase = await attr(B, '[data-live-phase]', 'data-live-phase');
    if (phase !== 'preview' && phase !== 'ended') throw new Error(`${B}: a live screen is already open in phase ${phase}`);
    await realClick(cx(B), phase === 'ended' ? '[data-live-ended] button' : '[data-live-close]');
    await rounds(async () => !(await has(B, '[data-live-overlay]')), 20);
  }

  // ── the broadcaster goes live ──
  await compose(B);
  if (!(await rounds(() => has(B, '[data-post-live]'), 20))) throw new Error(`${B}: the composer has no live chip`);
  await realClick(cx(B), '[data-post-live]');
  // THE RULES MAY LOAD AFTER THE SCREEN OPENS: every round accepts them if asked, else waits for Start.
  let rulesAccepted = false;
  const canStart = await rounds(async () => {
    if (await has(B, '[data-live-rules-accept]')) {
      await realClick(cx(B), '[data-live-rules-accept]');
      rulesAccepted = true;
      return false;
    }
    return (await ev(B, `(() => { const b = document.querySelector('[data-live-start]'); return !!b && !b.disabled; })()`)) === true;
  }, 40);
  if (!canStart) throw new Error(`${B}: Start never enabled (phase ${await attr(B, '[data-live-phase]', 'data-live-phase')})`);
  await realClick(cx(B), '[data-live-start]');
  const onAir = await rounds(async () => (await attr(B, '[data-live-phase]', 'data-live-phase')) === 'live', 40);
  log(`on air in round ${onAir}`);

  // ── the viewers: the card shows on a feed refresh (it has no timer of its own) ──
  const card = {};
  const join = {};
  for (const v of VIEWERS) {
    card[v] = await rounds(async () => {
      if (await has(v, '[data-live-open]')) return true;
      await nav(v, '/posts');
      return has(v, '[data-live-open]');
    }, 20);
  }
  for (const v of VIEWERS) {
    join[v] = null;
    if (!card[v]) continue;
    await realClick(cx(v), '[data-live-open]');
    join[v] = await rounds(async () => (await attr(v, '[data-live-viewer]', 'data-live-state')) === 'playing', 40);
  }

  // ── the watch: the video read at both ends of it ──
  const play = {};
  for (const v of VIEWERS) play[v] = { a: await ev(v, VIDEO) };
  const t0 = Date.now();
  await sleep(spec.watchRounds * ROUND_MS);
  for (const v of VIEWERS) play[v].b = await ev(v, VIDEO);
  const watchedMs = Date.now() - t0;
  const playing = Object.values(join).filter((r) => r !== null).length;
  const count = await rounds(async () => Number(await attr(B, '[data-live-viewer-count]', 'data-live-viewer-count')) >= playing, 40);
  const countShown = await attr(B, '[data-live-viewer-count]', 'data-live-viewer-count');

  // ── the broadcaster ends ──
  await realClick(cx(B), '[data-live-end]');
  await confirmDialog(cx(B), 'live_end_confirm_button');
  const ended = await rounds(async () => (await attr(B, '[data-live-phase]', 'data-live-phase')) === 'ended', 60);
  const seenEnded = {};
  for (const v of VIEWERS) seenEnded[v] = join[v] !== null ? await rounds(async () => (await attr(v, '[data-live-viewer]', 'data-live-state')) === 'ended', 60) : null;

  // ── L-F1: each viewer's own lines, in order ──
  const liveLines = Object.fromEntries(VIEWERS.map((v) => [v, consoleLines(cx(v)).filter((l) => /\[LIVE\]/.test(l))]));
  const stalls = Object.fromEntries(VIEWERS.map((v) => [v, stallsOf(liveLines[v])]));
  for (const v of VIEWERS) log(`${v}: gaps ${stalls[v].gaps.join(',') || 'none'} ms, target buffer now ${stalls[v].targets.join(',') || 'never moved'} ms, stalls ${stalls[v].stallsBefore} before / ${stalls[v].stallsAfter} after the first gap`);

  const measured = { onAir, card, join, play, watchedMs, count, countShown, ended, seenEnded, stalls };
  const { verdict, failures } = liveOwn(id, measured);
  for (const f of failures) log(f);
  log(`assertions: ${verdict}`);
  const logs = Object.fromEntries(spec.devices.map((d) => [d, liveNarration(id, d)]));
  const refusals = Object.fromEntries(spec.devices.map((d) => [d, liveRefusals(id, d)]));
  const observers = await observersOf(seats, { logs, refusals });
  await finishObserved(
    id,
    verdict,
    { rulesAccepted, ...measured, failures, liveLines, announce: srvLines('social-service', since).filter((l) => /\[LIVE_ANNOUNCE\]/.test(l)).slice(-5), serverWindowSince: since },
    observers,
    async () => closeSeats(seats)
  );
} catch (e) {
  console.error(`[${id}] ${e?.stack ?? e}`);
  let consoles = null;
  try {
    consoles = seats ? keepConsoles(id, consoleDump(Object.fromEntries(Object.entries(seats.seat ?? {}).map(([d, s]) => [d, { cx: s?.cx }])))) : null;
  } catch (k) {
    console.error(`[${id}] the seats' consoles could not be kept: ${String(k?.message ?? k)}`);
  }
  record(id, 'ERROR', { ...errorDetail(e), ...(consoles ? { consoles } : {}) });
  closeSeats(seats);
  process.exit(1);
}

/**
 * THE "NOUVEL APPAREIL" NOTICES A MINTING ROW LEAVES ON THE OWNER'S SEATS, DISMISSED THE WAY THE
 * OWNER DISMISSES THEM - THROUGH THE ROW'S "COMPRIS" IN `/notifications` - AND ONLY THE ONES THE ROW
 * MINTED.
 *
 * A row that mints a device of the owner's account (`newdevice.mjs`) is, to every other owner device
 * that merges the signed commit adding it, a new device on the account: `deviceNotices.svelte.ts`
 * queues a notice per device and key, persisted per account (`canari_device_notices:v1:<userId>`,
 * `accountLocalKeys.ts`), and `DeviceNoticeRow.svelte` lists each in `/notifications` (the app-wide banner was deleted
 * 2026-10-30), oldest first, until "Compris" (or the device list) is tapped. That is the product
 * working - and a notice the row never dismisses stays across reloads and in the bell's badge until
 * the list is opened, so every later row on that seat starts with a notice no row of its own put
 * there (seen on the campaign seats, 2026-10-27).
 *
 * **AN ALLOWLIST, NOT A SWEEP** (durable-rules: a destructive control needs an allowlist of what it
 * may touch). The row passes the device ids IT minted, and a notice is dismissed only while the one
 * in the list - the oldest pending - names one of them. The first notice of any other device STOPS the
 * dismissal: it is either a real device on the account or debris of another row, and in both cases
 * it is a finding to read, not a notice to clear. `cleanup.mjs` stays out of this on purpose
 * (coordinator, 2026-10-27): it cannot know which device a notice is about the way the minting row
 * does.
 *
 * **THE GESTURE, NOT THE STORE.** The queue is READ from localStorage, to know which notice is on
 * screen and to check after each tap that exactly that one left; it is never written. The row's
 * own button is tapped with `realClick` - the same dispatch on a browser seat and on the phone's
 * WebView (A1's tap path, `archive/liveweb.mjs`), after the seat opened `/notifications` through its own link (an in-app
 * navigation, no reload). Opening the list READS the notices - the badge clears, the rows stay - and
 * the stored queue is the same either way. A tap that removed anything but the expected
 * notice throws.
 *
 * Called AFTER the row's verdict is recorded (`finishObserved`'s teardown, or after `record`): the
 * dismissal prints `[DEVICE_NOTICE] new-device alert seen`, which belongs to no row's judgement.
 */
import { evaluate, realClick, until } from './cdp.mjs';

/** The store `deviceNotices.svelte.ts` persists per account (`ACCOUNT_KEY.deviceNotices`). */
export const NOTICE_STORE_PREFIX = 'canari_device_notices:v1:';

/** The hooks `DeviceNoticeRow.svelte` carries: the row (with its notice key) and its "Compris" button. */
export const ROW_KEY_ATTR = 'data-device-notice-key';
export const ROW_DISMISS_ATTR = 'data-device-notice-dismiss';
/** The notifications route the rows live on (`routes/notifications/+page.svelte`). */
export const NOTICES_ROUTE = '/notifications';

/** How long one tap may take to leave the store. */
const TAP_SETTLE_MS = 10_000;

/**
 * WHICH NOTICES TO TAP AWAY, from the stored queue (oldest first, the list's order) and the ids the
 * row minted. Pure, for the self-test.
 *
 * @param {{key: string, deviceId: string}[]} pending
 * @param {string[]} minted
 * @returns {{tap: string[], blockedBy: {key: string, deviceId: string} | null, behind: number}}
 *   `tap` the keys to dismiss, in order; `blockedBy` the first notice of a device the row did not
 *   mint, which stops the dismissal; `behind` the minted notices left queued behind it.
 */
export function dismissPlan(pending, minted) {
  const allow = new Set(minted.filter((id) => typeof id === 'string' && id.length > 0));
  const tap = [];
  let i = 0;
  for (; i < pending.length && allow.has(pending[i].deviceId); i++) tap.push(pending[i].key);
  const rest = pending.slice(i);
  return { tap, blockedBy: rest[0] ?? null, behind: rest.filter((n) => allow.has(n.deviceId)).length };
}

/**
 * The ONE account's pending queue out of the stores a seat holds. A seat holds one account; two
 * stores with pending notices is a seat this module cannot reason about, so it throws.
 *
 * @param {{account: string, pending: {key: string, deviceId: string}[]}[]} stores
 */
export function queueOf(stores) {
  const live = stores.filter((s) => s.pending.length > 0);
  if (live.length > 1) throw new Error(`device notices: ${live.length} accounts hold pending notices on one seat`);
  return live[0]?.pending ?? [];
}

/** The page-side read of every notice store: `{account, pending: [{key, deviceId}]}` each. */
const READ_STORES = `(() => Object.keys(localStorage)
  .filter((k) => k.startsWith(${JSON.stringify(NOTICE_STORE_PREFIX)}))
  .map((k) => {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(k)); } catch (e) { s = null; }
    const pending = Array.isArray(s && s.pending) ? s.pending : [];
    return {
      account: k.slice(${NOTICE_STORE_PREFIX.length}),
      pending: pending.filter((n) => n && typeof n.key === 'string' && typeof n.deviceId === 'string').map((n) => ({ key: n.key, deviceId: n.deviceId })),
    };
  }))()`;

/** Tags the visible link to the notifications route, to open it as the user does; false when none. */
const TAG_LINK = `(() => {
  document.querySelectorAll('[data-rig-notice-link]').forEach((e) => e.removeAttribute('data-rig-notice-link'));
  const link = [...document.querySelectorAll('a[href]')].find((a) => a.getClientRects().length && new URL(a.href, location.href).pathname === ${JSON.stringify(NOTICES_ROUTE)});
  if (!link) return false;
  link.setAttribute('data-rig-notice-link', '');
  return true;
})()`;

/** Tags the "Compris" button of the row of notice `key`; false when that row is not on screen. */
const tagDismiss = (key) => `(() => {
  document.querySelectorAll('[data-rig-notice]').forEach((e) => e.removeAttribute('data-rig-notice'));
  const row = [...document.querySelectorAll('[${ROW_KEY_ATTR}]')].find((r) => r.getAttribute(${JSON.stringify(ROW_KEY_ATTR)}) === ${JSON.stringify(key)} && r.getClientRects().length);
  const button = row && row.querySelector('[${ROW_DISMISS_ATTR}]');
  if (!button) return false;
  button.setAttribute('data-rig-notice', '');
  return true;
})()`;

/** Opens the notifications list through the seat's own link; a no-op when it is already open. */
async function openNoticeList(cx, seat) {
  if (await evaluate(cx, `location.pathname === ${JSON.stringify(NOTICES_ROUTE)}`)) return;
  if (!(await evaluate(cx, TAG_LINK))) throw new Error(`${seat}: no visible link to ${NOTICES_ROUTE} to open the device notices`);
  await realClick(cx, '[data-rig-notice-link]');
  await until(cx, `location.pathname === ${JSON.stringify(NOTICES_ROUTE)}`, TAP_SETTLE_MS);
}

/**
 * Dismisses, on one owner seat, the notices of the devices the row minted - through "Compris", one
 * at a time, each checked to have removed exactly itself. Never throws for a notice it leaves: the
 * row is recorded already, so what it leaves is REPORTED, at `error` when it is another device's.
 *
 * @param {object} cx the seat's CDP context (a browser seat or A1's WebView)
 * @param {string} seat the seat's name, for the report
 * @param {string[]} minted the device ids this row minted
 * @param {{log?: (s: string) => void}} [opts]
 * @returns {Promise<{seat: string, dismissed: number, foreign: boolean, behind: number}>}
 */
export async function dismissMintedNotices(cx, seat, minted, { log = console.log } = {}) {
  const pending = queueOf(await evaluate(cx, READ_STORES));
  const plan = dismissPlan(pending, minted);
  let dismissed = 0;
  if (plan.tap.length > 0) await openNoticeList(cx, seat);
  for (const key of plan.tap) {
    if (!(await evaluate(cx, tagDismiss(key)))) throw new Error(`${seat}: a minted device's notice is stored but its row is not in ${NOTICES_ROUTE}`);
    await realClick(cx, '[data-rig-notice]');
    const gone = `!${READ_STORES}.some((s) => s.pending.some((n) => n.key === ${JSON.stringify(key)}))`;
    await until(cx, gone, TAP_SETTLE_MS);
    const after = queueOf(await evaluate(cx, READ_STORES)).map((n) => n.key);
    const expected = pending.slice(dismissed + 1).map((n) => n.key);
    if (after.join('\n') !== expected.join('\n')) throw new Error(`${seat}: "Compris" removed something other than the minted device's notice (${after.length} left, ${expected.length} expected)`);
    dismissed += 1;
  }
  const out = { seat, dismissed, foreign: plan.blockedBy !== null, behind: plan.behind };
  if (out.foreign) console.error(`[device-notice] ${seat}: a notice of a device this row did NOT mint is on screen - left for a human to read (${plan.behind} minted notice(s) queued behind it)`);
  else log(`[device-notice] ${seat}: ${dismissed} notice(s) of the row's minted device(s) dismissed through "Compris"`);
  return out;
}

/**
 * {@link dismissMintedNotices} on each owner seat a row drives, in turn: one seat's failure is logged
 * and never keeps the next from being cleared. A seat given no minted id is skipped.
 *
 * @param {{seat: string, cx: object, minted: string[]}[]} seats
 */
export async function dismissMintedNoticesOn(seats) {
  for (const { seat, cx, minted } of seats) {
    if (!cx || minted.length === 0) continue;
    try {
      await dismissMintedNotices(cx, seat, minted);
    } catch (e) {
      console.error(`[device-notice] ${seat}: dismissal failed - ${String(e?.message ?? e)}`);
    }
  }
}

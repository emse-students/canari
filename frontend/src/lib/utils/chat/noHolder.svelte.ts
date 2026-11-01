import { SvelteSet } from 'svelte/reactivity';
import type { DistributionSeat, NoHolderFacts } from '$lib/mls-client/IMlsService';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { isWelcomeOwed, readWelcomeOwedFromSeat } from './welcomeOwed';

/**
 * A CONVERSATION THIS DEVICE CAN NO LONGER OPEN, SAID ONLY ON SERVER FACTS (owner, 2026-10-31, D5 of
 * `docs/wiki/protocols/mls-availability-no-holder.md`).
 *
 * The stored base is absent or behind the group's epoch, no member device is online to mint a new
 * one, and nothing is on its way to this device: RFC 9420 offers no entry, and the server never
 * resurrects a group. Instead of "En attente d'ajout..." for ever, the conversation says so in plain
 * words and offers to start again with the same people, or to take it off this account's list.
 *
 * THE BANNER MUST NEVER APPEAR FOR A CASE THAT IS STILL GOING TO RESOLVE, so it is decided by
 * {@link readNoHolder} alone, on the facts the server read IN ONE ANSWER (`NoHolderFacts`, carried by
 * a `no_peer_online` answer) - never on elapsed time, a missing message or a pending state:
 *
 * 1. the BASE first: a current base is one this device lets itself into (D1), so a slow Welcome can
 *    never reach the banner - the branch is reachable only once the base fact has ruled the join out;
 * 2. then the SEAT: a queued Welcome or an Add in flight is on its way, and an unreadable seat is
 *    unknown;
 * 3. then the HOLDERS: a group merely SLOW is not a dead one - while any other user's device still
 *    holds it and published a KeyPackage within the server's retention window, or this very answer
 *    woke member phones, the reading is `unknown` and the ordinary waiting text stays;
 * 4. only then, with the server's own verdict that no member device is online, `no-holder`.
 *
 * Every later answer replaces the reading: a member device online, a Welcome landing, a republished
 * base, a transport error (unknown) - each takes the banner away and the ordinary path resumes.
 * Session memory only: a restart starts from "unknown" and asks again.
 */
export type NoHolderReading =
  /** No facts: not asked yet, offline, a transport error, or a server that did not say. */
  | 'unknown'
  /** The stored base is current: this device lets itself in (D1), nothing to tell anyone. */
  | 'base-usable'
  /** A Welcome is queued for this device or an Add is in flight: it is on its way. */
  | 'welcome-owed'
  /** The whole fact set: no usable base, nothing on its way, no member online, no live holder. */
  | 'no-holder';

/**
 * Reads one `no_peer_online` answer's facts. PURE. The order of the checks IS the guarantee above.
 */
export function readNoHolder(facts: NoHolderFacts | undefined): NoHolderReading {
  if (!facts) return 'unknown';
  // 1. THE BASE. Current means the further-device door lets this device in by itself (D1).
  if (facts.base !== null && facts.base.baseEpoch >= facts.base.activeEpoch) return 'base-usable';
  // 2. THE SEAT. `active` while this device holds nothing is a state the server and the device do
  //    not agree on: unknown, never a dead end.
  if (facts.seat.status === 'active') return 'unknown';
  const reading = readWelcomeOwedFromSeat(facts.seat);
  if (reading === null) return 'unknown';
  if (isWelcomeOwed(reading)) return 'welcome-owed';
  // 3. THE HOLDERS. A live holder may yet come online, and a wake may yet bring one.
  if (facts.holders.liveHolderDevices !== 0 || facts.holders.wakeSent) return 'unknown';
  // 4. Reached only with the server's `no_peer_online` (the caller passes no facts otherwise).
  return 'no-holder';
}

/** Parses the `facts` of a server answer, `undefined` for anything that is not exactly that shape. */
export function parseNoHolderFacts(raw: unknown): NoHolderFacts | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { base?: unknown; seat?: unknown; holders?: unknown };
  let base: NoHolderFacts['base'];
  if (r.base === null) base = null;
  else if (
    r.base &&
    typeof r.base === 'object' &&
    Number.isFinite((r.base as { baseEpoch?: unknown }).baseEpoch) &&
    Number.isFinite((r.base as { activeEpoch?: unknown }).activeEpoch)
  ) {
    const b = r.base as { baseEpoch: number; activeEpoch: number };
    base = { baseEpoch: b.baseEpoch, activeEpoch: b.activeEpoch };
  } else return undefined;
  const seat = parseSeat(r.seat);
  const holders = parseHolders(r.holders);
  return seat && holders ? { base, seat, holders } : undefined;
}

/** Parses `holders`; `undefined` (so the whole answer reads as unknown) for any other shape. */
function parseHolders(raw: unknown): NoHolderFacts['holders'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const h = raw as { liveHolderDevices?: unknown; wakeSent?: unknown };
  if (!Number.isInteger(h.liveHolderDevices) || (h.liveHolderDevices as number) < 0) {
    return undefined;
  }
  if (typeof h.wakeSent !== 'boolean') return undefined;
  return { liveHolderDevices: h.liveHolderDevices as number, wakeSent: h.wakeSent };
}

/** Parses a served seat ({@link DistributionSeat}); `undefined` for any other shape. */
export function parseSeat(raw: unknown): DistributionSeat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as { status?: unknown; welcomeQueued?: unknown; addInFlight?: unknown };
  if (s.status === 'none' || s.status === 'active') return { status: s.status };
  if (s.status !== 'pending' || typeof s.welcomeQueued !== 'boolean') return undefined;
  return typeof s.addInFlight === 'boolean'
    ? { status: 'pending', welcomeQueued: s.welcomeQueued, addInFlight: s.addInFlight }
    : { status: 'pending', welcomeQueued: s.welcomeQueued };
}

/** The groups whose last answer read `no-holder`. Reactive. */
const unopenable = new SvelteSet<string>();

/**
 * Records what the latest answer about `groupId` says: `no-holder` shows the banner, anything else
 * takes it away. Called with EVERY answer of the recovery's asks (`recovery.ts`), so a fact that
 * changes is read on the next one.
 */
export function noteNoHolderReading(
  groupId: string,
  reading: NoHolderReading,
  log: (msg: string) => void
): void {
  const was = unopenable.has(groupId);
  if (reading === 'no-holder') {
    if (!was) {
      unopenable.add(groupId);
      log(
        `[NO_HOLDER] ${groupId.slice(0, 8)}... no usable base, nothing on its way, no member online - the conversation says it cannot be opened here`
      );
    }
    return;
  }
  if (was) {
    unopenable.delete(groupId);
    log(`[NO_HOLDER] ${groupId.slice(0, 8)}... ${reading} - the ordinary waiting path resumes`);
  }
}

/** Whether `groupId`'s banner is up. Reactive. */
export function isUnopenableHere(groupId: string): boolean {
  return unopenable.has(groupId);
}

/** Forgets every reading (sign-out, tests). */
export function resetNoHolderReadings(): void {
  unopenable.clear();
}

// ---------- Taken off this account's list ----------

/**
 * The most ids the hidden list keeps, oldest dropped first. A hidden id only ever matters while its
 * conversation cannot open, and is released the first time it is seen active
 * ({@link releaseHiddenOnceActive}), so the cap bounds what an account that hides many dead
 * conversations writes - it never decides what a live one shows.
 */
export const HIDDEN_UNOPENABLE_CAP = 200;

const hidden = new SvelteSet<string>();
let hiddenAccount: string | null = null;

/** Writes the hidden list of the bound account, in insertion order (oldest first). */
function persistHidden(userId: string): void {
  try {
    localStorage.setItem(ACCOUNT_KEY.unopenableHidden(userId), JSON.stringify([...hidden]));
  } catch (e) {
    console.error(`[NO_HOLDER] hidden list not persisted, a reload lists it again: ${String(e)}`);
  }
}

/** Binds the hidden list to `userId` (read once per account). */
export function loadHiddenUnopenable(userId: string): void {
  if (hiddenAccount === userId) return;
  hiddenAccount = userId;
  hidden.clear();
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.unopenableHidden(userId));
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(ids)) {
      for (const id of ids.slice(-HIDDEN_UNOPENABLE_CAP))
        if (typeof id === 'string') hidden.add(id);
    }
  } catch (e) {
    console.error(`[NO_HOLDER] hidden list unreadable, every conversation is listed: ${String(e)}`);
  }
}

/**
 * Takes `groupId` off this account's list - the user's choice on the banner. NOTHING is deleted, on
 * the server or here: the row, the seat and the recovery stay, so if a device that held the
 * conversation ever comes back and adds this one, it is listed again ({@link isHiddenFromList}).
 */
export function hideUnopenable(userId: string, groupId: string): void {
  loadHiddenUnopenable(userId);
  hidden.delete(groupId);
  hidden.add(groupId);
  for (const oldest of [...hidden].slice(0, Math.max(0, hidden.size - HIDDEN_UNOPENABLE_CAP))) {
    hidden.delete(oldest);
  }
  persistHidden(userId);
  console.log(`[NO_HOLDER] ${groupId.slice(0, 8)}... taken off the list by its user`);
}

/**
 * Releases `groupId` from the hidden list THE FIRST TIME IT IS SEEN ACTIVE (review of #2832): the
 * hiding meant "while it cannot open", so once it opened the choice is spent. Kept, it would hide a
 * live conversation the day a later recovery made it pending again. Called where the group is known
 * held again (`cancelReAdd`) and by the list for every active row it renders. A no-op for an id that
 * is not hidden, or before the account's list is bound.
 */
export function releaseHiddenOnceActive(groupId: string): void {
  if (hiddenAccount === null || !hidden.has(groupId)) return;
  hidden.delete(groupId);
  persistHidden(hiddenAccount);
  console.log(`[NO_HOLDER] ${groupId.slice(0, 8)}... opened - back on the list for good`);
}

/**
 * Whether a conversation is off the list: the user hid it AND it is still not active. A Welcome that
 * makes it active lists it again by itself, and releases the id ({@link releaseHiddenOnceActive}).
 */
export function isHiddenFromList(groupId: string, lifecycle: string | undefined): boolean {
  return lifecycle !== 'active' && hidden.has(groupId);
}

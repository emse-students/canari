import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { Log } from '$lib/utils/Log';
import { HELP_ID_UNKNOWN, isHelpId, type HelpId } from './helpIds';

/**
 * WHICH FIRST-TIME HELPS THIS ACCOUNT HAS SEEN - the client half of core-service's `help_seen`
 * (docs/wiki/frontend/guided-help.md).
 *
 * THE SERVER IS THE TRUTH, ACROSS DEVICES (owner, 2026-11-02): a tour finished on the phone is not
 * shown on the laptop. This store keeps an OPTIMISTIC copy per account in `localStorage`
 * (`ACCOUNT_KEY.seenHelps`, swept by the account deletion), so a help closed offline does not come
 * back before the server hears of it, and it records which ids the server has NOT acknowledged yet.
 *
 * NO RETRY TIMER. A write that met no answer is OWED, and two events deliver what is owed - the
 * reconnect (`connectivity.onReconnect`, the same trigger the salon writes use) and the next
 * {@link SeenHelps.load} (the next app opening, or the next account sign-in). ONE refusal is not
 * owed: the 400 whose typed `code` is `HELP_ID_UNKNOWN` (an id the server does not list), which no
 * repeat can change - it is logged as the release mismatch it is and dropped. Every other status - a
 * 429, a 408, a 401, a 5xx - says nothing permanent about the id, so the write stays owed.
 *
 * AN UNSEEN HELP STARTS ONLY ONCE THE SERVER HAS ANSWERED ({@link SeenHelps.ready}): starting on the
 * local copy alone would replay, on a new device, a tour the account finished elsewhere. A device
 * that cannot reach the server shows no new help - nothing is lost, the next opening asks again.
 */

type Persisted = { seen: string[]; owed: string[] };

const PATH = '/api/users/me/help-seen';

/**
 * Whether a failed write is the server's PERMANENT refusal of the id: a 400 carrying the typed
 * `HELP_ID_UNKNOWN` code. Read from the body's `code`, never from a message; an unreadable body is
 * not that refusal.
 */
async function isUnknownIdRefusal(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    return body?.code === HELP_ID_UNKNOWN;
  } catch (e) {
    console.warn('[seenHelps] a 400 with no readable body - kept owed', e);
    return false;
  }
}

function readLocal(userId: string): { seen: HelpId[]; owed: HelpId[] } {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.seenHelps(userId));
    if (!raw) return { seen: [], owed: [] };
    const parsed = JSON.parse(raw) as Partial<Persisted> | null;
    const seen = Array.isArray(parsed?.seen) ? parsed.seen.filter(isHelpId) : [];
    const owed = Array.isArray(parsed?.owed) ? parsed.owed.filter(isHelpId) : [];
    return { seen, owed };
  } catch (e) {
    console.warn(
      '[seenHelps] the local copy could not be read - starting from the server alone',
      e
    );
    return { seen: [], owed: [] };
  }
}

export class SeenHelps {
  #account: string | null = null;
  #seen = new SvelteSet<HelpId>();
  /** Seconds since the SERVER recorded each help, as of the last answer - never computed here. */
  #ageSeconds = new SvelteMap<HelpId, number>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- nothing renders what is owed
  #owed = new Set<HelpId>();
  #ready = $state(false);
  /** Moves on with every account change, so an answer for the previous account is dropped. */
  #generation = 0;
  #stopReconnect: (() => void) | null = null;
  /** The read in flight for the current account: a second `load` joins it instead of asking again. */
  #loading: Promise<void> | null = null;

  /** Whether the server's set has been merged for the current account. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Whether the current account has seen `id` (server or local copy). Reactive. */
  has(id: HelpId): boolean {
    return this.#seen.has(id);
  }

  /**
   * How long ago the SERVER recorded `id`, in seconds, as of its last answer - `null` when it has not
   * said (not seen, or recorded on this device and still owed). A rule measured from a first showing
   * ("30 days later") reads this, never its own clock. Reactive.
   */
  ageSeconds(id: HelpId): number | null {
    return this.#ageSeconds.get(id) ?? null;
  }

  /** The ids not yet acknowledged by the server, for the tests and the log. */
  get owed(): HelpId[] {
    return [...this.#owed];
  }

  /**
   * Opens the account's state: the local copy at once, then the server's set, then whatever is
   * owed. Called whenever the signed-in account is known; a repeat for the same account is a no-op
   * once the server has answered.
   */
  load(userId: string): Promise<void> {
    if (this.#account === userId && this.#ready) return Promise.resolve();
    if (this.#account === userId && this.#loading) return this.#loading;
    const loading = this.#load(userId).finally(() => {
      if (this.#loading === loading) this.#loading = null;
    });
    this.#loading = loading;
    return loading;
  }

  async #load(userId: string): Promise<void> {
    if (this.#account !== userId) {
      this.reset();
      this.#account = userId;
      const local = readLocal(userId);
      for (const id of local.seen) this.#seen.add(id);
      for (const id of local.owed) this.#owed.add(id);
      Log.d('seenHelps', `local copy: ${local.seen.length} seen, ${local.owed.length} owed`);
    }
    const generation = this.#generation;
    try {
      const res = await apiFetch(`${coreUrl()}${PATH}`);
      if (generation !== this.#generation) return;
      if (!res.ok) {
        // An ANSWER that is not the set: a defect on the server or a route that moved. Accused, and
        // asked again at the next opening; no help starts meanwhile.
        console.error(`[seenHelps] the seen-help route refused: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { seen?: unknown; ageSeconds?: unknown } | null;
      if (generation !== this.#generation) return;
      const server = Array.isArray(body?.seen) ? body.seen.filter(isHelpId) : [];
      const ages = (body?.ageSeconds ?? {}) as Record<string, unknown>;
      for (const id of server) {
        const age = ages[id];
        if (typeof age === 'number' && Number.isFinite(age) && age >= 0) {
          this.#ageSeconds.set(id, age);
        }
        this.#seen.add(id);
        // The server holds it already: whatever this device owed for it is settled.
        this.#owed.delete(id);
      }
      this.#persist();
      this.#ready = true;
      Log.d('seenHelps', `server answered: ${server.length} seen, ${this.#owed.size} owed`);
    } catch (e) {
      if (generation !== this.#generation) return;
      if (isTransportFailure(e)) {
        Log.i('seenHelps', 'the seen set could not be read - asked again at the reconnect');
        this.#owe();
        return;
      }
      console.error('[seenHelps] reading the seen set failed', e);
      return;
    }
    await this.deliverOwed();
  }

  /**
   * Records `id` as seen: locally at once (optimistic), then on the server. A write that does not
   * reach the server stays owed (see the module comment).
   */
  markSeen(id: HelpId): void {
    if (!this.#account) {
      console.warn(`[seenHelps] ${id} seen with no account open - not recorded`);
      return;
    }
    this.#seen.add(id);
    this.#owed.add(id);
    this.#persist();
    void this.#deliver(id);
  }

  /** Delivers every owed id. One failure never stops the others. */
  async deliverOwed(): Promise<void> {
    const owed = [...this.#owed];
    if (owed.length === 0) return;
    Log.i('seenHelps', `${owed.length} seen help(s) owed to the server - delivering`);
    await Promise.all(owed.map((id) => this.#deliver(id)));
  }

  async #deliver(id: HelpId): Promise<void> {
    const generation = this.#generation;
    try {
      const res = await apiFetch(`${coreUrl()}${PATH}/${encodeURIComponent(id)}`, {
        method: 'POST',
      });
      if (generation !== this.#generation) return;
      if (res.ok) {
        this.#owed.delete(id);
        this.#persist();
        Log.d('seenHelps', `${id} recorded on the account`);
        return;
      }
      const permanent = await isUnknownIdRefusal(res);
      if (generation !== this.#generation) return;
      if (permanent) {
        // The server does not list this id: owing it would only repeat the refusal. Accused - it is
        // a release mismatch between this client and the server's allowlist.
        console.error(
          `[seenHelps] the server does not list ${id} (${HELP_ID_UNKNOWN}) - kept local only`
        );
        this.#owed.delete(id);
        this.#persist();
        return;
      }
      console.warn(`[seenHelps] ${id} not recorded: HTTP ${res.status} - owed to the next opening`);
    } catch (e) {
      if (generation !== this.#generation) return;
      if (!isTransportFailure(e)) {
        console.error(`[seenHelps] recording ${id} failed`, e);
        return;
      }
      Log.i('seenHelps', `${id} not recorded (no answer) - owed to the reconnect`);
      this.#owe();
    }
  }

  /** Waits for the reconnect to load or deliver again - one subscription, whatever is owed. */
  #owe(): void {
    if (this.#stopReconnect) return;
    this.#stopReconnect = connectivity.onReconnect(() => {
      this.#stopReconnect?.();
      this.#stopReconnect = null;
      const account = this.#account;
      if (!account) return;
      Log.i('seenHelps', 'reconnect: reading the seen set and delivering what is owed');
      void (this.#ready ? this.deliverOwed() : this.load(account));
    });
  }

  #persist(): void {
    const account = this.#account;
    if (!account) return;
    const value: Persisted = { seen: [...this.#seen], owed: [...this.#owed] };
    try {
      localStorage.setItem(ACCOUNT_KEY.seenHelps(account), JSON.stringify(value));
    } catch (e) {
      console.warn('[seenHelps] the local copy could not be written', e);
    }
  }

  /** Forgets the account (sign-out): the next account is read on its own behalf. */
  reset(): void {
    this.#generation++;
    this.#account = null;
    this.#seen.clear();
    this.#ageSeconds.clear();
    this.#owed.clear();
    this.#ready = false;
    this.#loading = null;
    this.#stopReconnect?.();
    this.#stopReconnect = null;
  }
}

/** The app's one store. */
export const seenHelps = new SeenHelps();

/** Sign-out hook: called by `sessionAuth.ts` with the other per-account resets. */
export function resetSeenHelps(): void {
  seenHelps.reset();
}

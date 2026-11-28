/**
 * Which notification categories this ACCOUNT has switched off, mirrored from the server.
 *
 * NOT `settingsStore`, and that is the point: sound and vibration are per DEVICE in `localStorage`,
 * whereas this follows the account across devices and is the same set the server applies before it
 * sends a push. A client-only copy would leave the server sending what this one hides. The server
 * stays the authority; this store is what the settings screen edits and what the client's own local
 * notifications (raised from a socket frame, where no push is involved) consult.
 *
 * It also mirrors each private conversation's LEVEL (all / mentions / none), the salon's three levels
 * for an MLS group or DM, read in the same request and applied by `useMessaging.notifyInbound` to
 * the notifications this client raises itself.
 *
 * WHAT IT HOLDS BEFORE THE SERVER ANSWERS (decided 2026-11-27, docs/wiki/services/chat-delivery.md):
 * the LAST set the server answered for this account, kept on the device
 * (`ACCOUNT_KEY.notificationPreferences`, erased at that account's sign-out) and applied at sign-in
 * ({@link notificationPreferences.bind}); only with no copy, the account default - every category ON,
 * no PUSH of an opt-in category (`OPT_IN_CATEGORIES`, owner's "Deux niveaux" of 2026-11-11).
 * {@link notificationPreferences.source} says which. A failed read is LATCHED: nothing reads again
 * until connectivity comes back, the app comes back on screen, the next sign-in, or an explicit load
 * (the settings screen) - never once per frame, never on a clock - and an offline session starts no
 * read at all.
 */
import {
  fetchChannelNotificationLevel,
  fetchNotificationPreferences,
  saveDisabledCategories,
  saveGroupCallsAllowed,
  saveGroupNotificationLevel,
} from '$lib/notifications/preferencesApi';
import { callsAllowedFor } from '$lib/notifications/callPermission';
import { OPT_IN_CATEGORIES, type NotificationCategory } from '$lib/notifications/categories';
import {
  isConversationNotificationLevel,
  type ConversationNotificationLevel,
} from '$lib/notifications/conversationLevel';
import {
  parseNotificationPreferences,
  toNotificationPreferencesWire,
  type NotificationPreferencesSnapshot,
} from '$lib/notifications/preferencesSnapshot';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { onAppScreenChange } from '$lib/utils/appForeground';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { SvelteMap } from 'svelte/reactivity';
import { Log } from '$lib/utils/Log';

let disabled = $state<NotificationCategory[]>([]);
/**
 * The opt-in categories whose PUSH is on. Empty by default, so a save made before the first load can
 * never turn a push on by omission.
 */
let pushEnabled = $state<NotificationCategory[]>([]);
/** Switched-off ids this build does not know, as read: sent back on every save, never drawn. */
let unknownDisabled: string[] = [];
/** Serialises writes: each PUT carries the whole set, so two in flight could land out of order. */
let writeChain: Promise<unknown> = Promise.resolve();
/** Private conversations quieter than `all`, by group id; an absent one is `all`. */
let groupLevels = $state<Record<string, ConversationNotificationLevel>>({});
/** Private conversations where the account CHOSE whether calls ring; an absent one follows its level. */
let groupCalls = $state<Record<string, boolean>>({});
/**
 * A salon's level for this account, by channel id (no `channel_` prefix), once this session has read
 * it. Unlike {@link groupLevels} it is not listed at sign-in - it lives in the social service - so an
 * ABSENT key means "not read yet", never `all`.
 */
let channelLevels = $state<Record<string, ConversationNotificationLevel>>({});
/** One read in flight per salon: a burst of frames asks once, not once per frame. */
const channelReads = new SvelteMap<string, Promise<ChannelLevelRead>>();
const channelKey = (id: string): string => id.replace(/^channel_/, '');
/** Whether {@link groupLevels} has been answered by the server at least once this session. */
let loaded = $state(false);
/** Where the set in memory comes from - see {@link PreferencesSource}. */
let source = $state<PreferencesSource>('default');
/** The one read in flight: every caller that asks while it runs shares its answer. */
let loadInFlight: Promise<boolean> | null = null;
/** Names the read {@link loadInFlight} holds, so only that read clears it when it settles. */
let loadSeq = 0;
/**
 * WHICH SESSION the set is, as a number: bumped at every sign-in ({@link notificationPreferences.bind})
 * and sign-out ({@link notificationPreferences.reset}). A read or a save that answers under another
 * one writes nothing - not into the set, not into a device copy. A parked DECISION is keyed on the
 * {@link account} instead (see {@link PreferencesAnswer}): the same account signed in again is still
 * its recipient.
 */
let generation = 0;
/** The account the set belongs to, whose device copy is read and written; null when signed out. */
let account: string | null = null;
/** An offline session reads nothing until it is promoted (`promoteOfflineSession` calls `load`). */
let offline = false;
/**
 * A read FAILED, and nothing reads again until connectivity returns, the app comes back on screen,
 * the next sign-in or an explicit {@link notificationPreferences.load}. Holds the unsubscribe of the
 * listeners that lift it. An HTTP error is an answer, not a disconnection, so connectivity alone
 * would keep a 5xx latched until a sign-in; the next resume is the user coming back, an EVENT - no
 * timer decides when to ask again.
 */
let failedLatch: (() => void) | null = null;

/**
 * Where the set a decision reads comes from: `answered` this session by the server, `persisted` (the
 * device's copy of the last answer, applied at sign-in), or the account `default` (no copy at all).
 */
export type PreferencesSource = 'answered' | 'persisted' | 'default';

/**
 * What {@link notificationPreferences.answered} resolves to, typed where it is KNOWN:
 * - `answered`: the server's set is in memory;
 * - `unanswered`: no answer this session (the read failed, is latched, or the session is offline) -
 *   the set in memory is `source`, `persisted` or `default`;
 * - `superseded`: no account is signed in, or another one is, than the one the caller asked for -
 *   the set in memory is not that account's, and the caller decides NOTHING. The SAME account signed
 *   in again is not superseded: the caller is answered by that new session instead.
 */
export type PreferencesAnswer =
  | { kind: 'answered' }
  | { kind: 'unanswered'; source: Exclude<PreferencesSource, 'answered'> }
  | { kind: 'superseded' };

const EMPTY_SET: NotificationPreferencesSnapshot = {
  disabled: [],
  pushEnabled: [],
  unknownDisabled: [],
  groupLevels: {},
  groupCalls: {},
};

function apply(snapshot: NotificationPreferencesSnapshot): void {
  disabled = snapshot.disabled;
  pushEnabled = snapshot.pushEnabled;
  unknownDisabled = snapshot.unknownDisabled;
  groupLevels = snapshot.groupLevels;
  groupCalls = snapshot.groupCalls;
}

/** Keeps the set in memory as the account's device copy - called only once the server holds it. */
function persist(): void {
  if (!account) return;
  try {
    const wire = toNotificationPreferencesWire({
      disabled,
      pushEnabled,
      unknownDisabled,
      groupLevels,
      groupCalls,
    });
    localStorage.setItem(ACCOUNT_KEY.notificationPreferences(account), JSON.stringify(wire));
  } catch (e) {
    console.warn('[NOTIF_PREF] the device copy of the settings could not be written', e);
  }
}

/** The account's device copy, validated like an answer; null when there is none or it is unreadable. */
function readPersisted(userId: string): NotificationPreferencesSnapshot | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.notificationPreferences(userId));
    return raw === null ? null : parseNotificationPreferences(JSON.parse(raw), 'the device copy');
  } catch (e) {
    console.warn('[NOTIF_PREF] the device copy of the settings is unreadable - not used', e);
    return null;
  }
}

function clearLatch(): void {
  failedLatch?.();
  failedLatch = null;
}

/**
 * How a salon level read ended: `read` (cached), `failed` (nothing cached, the next frame asks again),
 * or `superseded` - a sign-in or sign-out came between the request and its answer, which was dropped:
 * the caller reads again under the new session if the frame is still that account's.
 */
export type ChannelLevelRead = 'read' | 'failed' | 'superseded';

/** Latches a failed read until one of the events that lift it (see {@link failedLatch}). */
function latch(): void {
  clearLatch();
  const lift = (why: string) => {
    if (!failedLatch) return;
    clearLatch();
    console.log(`[NOTIF_PREF] ${why} - the settings are read again`);
    void notificationPreferences.load();
  };
  const offReconnect = connectivity.onReconnect(() => lift('connectivity returned'));
  const offScreen = onAppScreenChange((onScreen) => {
    if (onScreen) lift('the app is back on screen');
  });
  failedLatch = () => {
    offReconnect();
    offScreen();
  };
}

/**
 * Whether the account a save started under is still the one in memory: a save that answers after a
 * sign-out landed for the leaving account on the server, and neither its copy nor its revert may
 * touch the next account's set.
 */
function stillSession(started: number, what: string): boolean {
  if (started === generation) return true;
  console.log(`[NOTIF_PREF] ${what} answered after its account signed out - not applied here`);
  return false;
}

const sameSet = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Applies the two sets at once and writes them, serialised behind the previous write: each PUT
 * carries both whole sets. On a refusal only `category` goes back - a later toggle of another
 * category may already have landed.
 */
function commit(
  what: string,
  nextDisabled: NotificationCategory[],
  nextPush: NotificationCategory[],
  category: NotificationCategory
): Promise<boolean> {
  if (sameSet(nextDisabled, disabled) && sameSet(nextPush, pushEnabled)) {
    return Promise.resolve(true);
  }
  const wasOff = disabled.includes(category);
  const wasPushed = pushEnabled.includes(category);
  disabled = nextDisabled;
  pushEnabled = nextPush;
  const started = generation;
  const write = writeChain.then(async () => {
    try {
      await saveDisabledCategories(disabled, unknownDisabled, pushEnabled);
      if (stillSession(started, what)) persist();
      return true;
    } catch (e) {
      if (!stillSession(started, what)) return false;
      Log.d(`notificationPreferences.${what} failed - reverting`, e);
      disabled = wasOff
        ? disabled.includes(category)
          ? disabled
          : [...disabled, category]
        : disabled.filter((c) => c !== category);
      pushEnabled = wasPushed
        ? pushEnabled.includes(category)
          ? pushEnabled
          : [...pushEnabled, category]
        : pushEnabled.filter((c) => c !== category);
      return false;
    }
  });
  writeChain = write;
  return write;
}

export const notificationPreferences = {
  /** The categories currently switched off. */
  get disabled(): readonly NotificationCategory[] {
    return disabled;
  },

  /** True unless the account switched this category off (for an opt-in one: in the app). */
  isEnabled(category: NotificationCategory): boolean {
    return !disabled.includes(category);
  },

  /**
   * Whether this category may be PUSHED - and so raised as a notification by this client itself: on,
   * and for an opt-in category also its push turned on. The server's `effectiveDisabledCategories`.
   */
  pushAllowed(category: NotificationCategory): boolean {
    if (disabled.includes(category)) return false;
    return !OPT_IN_CATEGORIES.includes(category) || pushEnabled.includes(category);
  },

  /** Whether the account turned an opt-in category's push on (and kept the category on). */
  isPushEnabled(category: NotificationCategory): boolean {
    return pushEnabled.includes(category) && !disabled.includes(category);
  },

  /**
   * Binds the store to the account that just signed in: the generation moves (a decision parked for
   * anyone before is superseded), the account's device copy - if any - is applied as `persisted`, and
   * an `offline` session is told to start no read until it is promoted. Called by the sign-in before
   * any frame can arrive; it starts no read itself.
   */
  bind(userId: string, options: { offline: boolean }): void {
    generation++;
    loadInFlight = null;
    clearLatch();
    account = userId;
    offline = options.offline;
    loaded = false;
    // Defensive: `reset` already emptied it, and a salon level is read again per session anyway.
    channelLevels = {};
    channelReads.clear();
    const copy = readPersisted(userId);
    apply(copy ?? EMPTY_SET);
    source = copy ? 'persisted' : 'default';
    console.log(`[NOTIF_PREF] bound to the account - its ${source} set until the server answers`);
  },

  /**
   * Reads the account's set from the server. Never throws; a failure is logged, keeps the set in
   * memory and LATCHES (see {@link answered}). A call made while a read is in flight shares it. An
   * explicit call is the caller's own judgement that the network is worth trying (the settings
   * screen, an offline session promoted), so it lifts the latch and the offline mark.
   */
  load(): Promise<boolean> {
    if (loadInFlight) return loadInFlight;
    // Signed out (or not yet bound): there is nobody to read the settings of.
    if (account === null) {
      console.log('[NOTIF_PREF] no account bound - the settings are not read');
      return Promise.resolve(false);
    }
    offline = false;
    clearLatch();
    const started = generation;
    const seq = ++loadSeq;
    // Started on the next microtask, so `loadInFlight` is set before the read can settle - even when
    // the request throws synchronously.
    const read = Promise.resolve().then(async () => {
      try {
        const snapshot = await fetchNotificationPreferences();
        if (started !== generation) {
          console.log('[NOTIF_PREF] a read answered after its account signed out - dropped');
          return false;
        }
        apply(snapshot);
        loaded = true;
        source = 'answered';
        persist();
        return true;
      } catch (e) {
        if (started !== generation) return false;
        console.warn(
          `[NOTIF_PREF] the settings read failed - deciding on the ${source} set, no read again until connectivity returns or the app comes back on screen`,
          e
        );
        latch();
        return false;
      } finally {
        if (seq === loadSeq) loadInFlight = null;
      }
    });
    loadInFlight = read;
    return read;
  },

  /** Where the set in memory comes from (see {@link PreferencesSource}). */
  get source(): PreferencesSource {
    return source;
  },

  /**
   * The account signed in, null when none: captured by a decision it parks and compared when it
   * resumes - another account (or none) means the decision is not this set's to take.
   */
  get account(): string | null {
    return account;
  },

  /**
   * Resolves once there is nothing better to wait for: at once when the server has answered, else by
   * joining the read in flight, else by starting one - unless the session is offline or a failed read
   * is latched, which resolve at once as `unanswered`. Typed where each outcome is KNOWN; see
   * {@link PreferencesAnswer}.
   *
   * WHY A DECISION WAITS FOR IT. A phone woken in the background by a SILENT push (the server's own
   * answer to `none`) pulls and decrypts the frame before the sign-in read answers, and raised it
   * under the default: a group at "Aucune" rang the iPhone (1.8.3-alpha.1, 2026-11-27).
   */
  answered(): Promise<PreferencesAnswer> {
    const asker = account;
    // Signed out: no read is started for nobody, and nothing is decided.
    if (asker === null) return Promise.resolve({ kind: 'superseded' });
    const started = generation;
    const outcome = (): PreferencesAnswer =>
      account !== asker
        ? { kind: 'superseded' }
        : source === 'answered'
          ? { kind: 'answered' }
          : { kind: 'unanswered', source };
    if (loaded) return Promise.resolve(outcome());
    const read = loadInFlight ?? (offline || failedLatch ? null : this.load());
    if (!read) return Promise.resolve(outcome());
    return read.then(() =>
      // The same account signed out and in again while it waited: the read it joined belonged to
      // the session that ended, so it is answered by the new one's.
      account === asker && generation !== started ? this.answered() : outcome()
    );
  },

  /**
   * Switches one category on or off. Optimistic like the per-salon level: the switch moves at once
   * and returns if the server refuses. Switching an opt-in category off switches its push off too -
   * one gesture. Resolves false when the write failed (and was reverted).
   */
  setEnabled(category: NotificationCategory, enabled: boolean): Promise<boolean> {
    const nextDisabled = enabled
      ? disabled.filter((c) => c !== category)
      : disabled.includes(category)
        ? disabled
        : [...disabled, category];
    const nextPush = enabled ? pushEnabled : pushEnabled.filter((c) => c !== category);
    return commit(`setEnabled(${category}, ${enabled})`, nextDisabled, nextPush, category);
  },

  /**
   * Turns an opt-in category's PUSH on or off. Turning it on turns the category on too: a push of
   * suggestions the reader does not see in the app would be one they cannot read. Resolves false
   * when the write failed (and was reverted).
   */
  setPushEnabled(category: NotificationCategory, enabled: boolean): Promise<boolean> {
    if (!OPT_IN_CATEGORIES.includes(category)) {
      Log.w(
        `notificationPreferences.setPushEnabled(${category}): not an opt-in category - ignored`
      );
      return Promise.resolve(false);
    }
    const nextPush = enabled
      ? pushEnabled.includes(category)
        ? pushEnabled
        : [...pushEnabled, category]
      : pushEnabled.filter((c) => c !== category);
    const nextDisabled = enabled ? disabled.filter((c) => c !== category) : disabled;
    return commit(`setPushEnabled(${category}, ${enabled})`, nextDisabled, nextPush, category);
  },

  /** Whether the server has answered the levels yet - a control must not draw a level that lies. */
  get loaded(): boolean {
    return loaded;
  },

  /** This account's level for one private conversation (`all` when never set). */
  groupLevel(groupId: string): ConversationNotificationLevel {
    return groupLevels[groupId] ?? 'all';
  },

  /**
   * Sets one conversation's level. Optimistic like the salon control: it moves at once and returns
   * if the server refuses. Resolves false when the write failed (and was reverted).
   */
  async setGroupLevel(groupId: string, level: ConversationNotificationLevel): Promise<boolean> {
    const before = groupLevels[groupId] ?? 'all';
    if (before === level) return true;
    const apply = (l: ConversationNotificationLevel) => {
      const next = { ...groupLevels };
      if (l === 'all') delete next[groupId];
      else next[groupId] = l;
      groupLevels = next;
    };
    apply(level);
    const started = generation;
    const what = `setGroupLevel(${groupId}, ${level})`;
    try {
      await saveGroupNotificationLevel(groupId, level);
      if (stillSession(started, what)) persist();
      return true;
    } catch (e) {
      if (!stillSession(started, what)) return false;
      Log.d(`notificationPreferences.setGroupLevel(${groupId}, ${level}) failed - reverting`, e);
      apply(before);
      return false;
    }
  },

  /**
   * Whether a call in this private conversation may ring this account: the explicit choice, else
   * the level's default (rings unless `none`). Until the first load answers this is the account
   * default - calls ring - like every other setting this store mirrors.
   */
  callsAllowed(groupId: string): boolean {
    return callsAllowedFor(groupLevels[groupId] ?? 'all', groupCalls[groupId]);
  },

  /**
   * Records whether calls in one conversation may ring this account. Optimistic like the level: it
   * moves at once and returns to the previous state (an explicit choice, or none) if the server
   * refuses. Resolves false when the write failed (and was reverted).
   */
  async setGroupCallsAllowed(groupId: string, allowed: boolean): Promise<boolean> {
    const had = Object.hasOwn(groupCalls, groupId);
    const before = groupCalls[groupId];
    if (had && before === allowed) return true;
    groupCalls = { ...groupCalls, [groupId]: allowed };
    const started = generation;
    const what = `setGroupCallsAllowed(${groupId}, ${allowed})`;
    try {
      await saveGroupCallsAllowed(groupId, allowed);
      if (stillSession(started, what)) persist();
      return true;
    } catch (e) {
      if (!stillSession(started, what)) return false;
      Log.d(
        `notificationPreferences.setGroupCallsAllowed(${groupId}, ${allowed}) failed - reverting`,
        e
      );
      const next = { ...groupCalls };
      if (had) next[groupId] = before;
      else delete next[groupId];
      groupCalls = next;
      return false;
    }
  },

  /** A salon's level once read this session, `undefined` while it has not been. */
  channelLevel(channelId: string): ConversationNotificationLevel | undefined {
    return channelLevels[channelKey(channelId)];
  },

  /**
   * Records a salon's level the caller already holds - the settings panel on open and after a save -
   * so a level changed on ANOTHER device is picked up the next time the panel opens, as for a group.
   */
  rememberChannelLevel(channelId: string, level: ConversationNotificationLevel): void {
    channelLevels = { ...channelLevels, [channelKey(channelId)]: level };
  },

  /**
   * Reads a salon's level once (shared in-flight read, cached after). Resolves `failed` - logged,
   * nothing cached, so the next frame asks again - when the read failed, and `superseded` when it
   * answered after a sign-in or sign-out (see {@link ChannelLevelRead}). Never throws.
   */
  loadChannelLevel(channelId: string): Promise<ChannelLevelRead> {
    const key = channelKey(channelId);
    const pending = channelReads.get(key);
    if (pending) return pending;
    const started = generation;
    // On the next microtask, so the entry below is set before the read can settle.
    const read: Promise<ChannelLevelRead> = Promise.resolve().then(async () => {
      try {
        const level = await fetchChannelNotificationLevel(key);
        // Like `load`: an answer for the account that signed out is never written into the next one's.
        if (!stillSession(started, `loadChannelLevel(${key})`)) return 'superseded';
        if (!isConversationNotificationLevel(level)) {
          throw new Error(`unknown salon notification level "${String(level)}"`);
        }
        channelLevels = { ...channelLevels, [key]: level };
        return 'read';
      } catch (e) {
        Log.d(`notificationPreferences.loadChannelLevel(${key}) failed`, e);
        return 'failed';
      } finally {
        if (channelReads.get(key) === read) channelReads.delete(key);
      }
    });
    channelReads.set(key, read);
    return read;
  },

  /**
   * Back to the account default - on sign-out, so the next account never inherits a set - and the
   * leaving account's device copy is erased with it.
   */
  reset(): void {
    if (account) {
      try {
        localStorage.removeItem(ACCOUNT_KEY.notificationPreferences(account));
      } catch (e) {
        console.warn('[NOTIF_PREF] the device copy of the settings could not be erased', e);
      }
    }
    account = null;
    offline = false;
    clearLatch();
    source = 'default';
    disabled = [];
    pushEnabled = [];
    unknownDisabled = [];
    groupLevels = {};
    groupCalls = {};
    channelLevels = {};
    channelReads.clear();
    loaded = false;
    loadInFlight = null;
    generation++;
  },
};

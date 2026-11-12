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
 * Until the first load answers, the account default holds - every category ON, and no PUSH of an
 * opt-in category (`OPT_IN_CATEGORIES`: "Suggestions" in the app on, its push off until turned on,
 * owner's "Deux niveaux" of 2026-11-11) - and a failed load says so and keeps that default rather
 * than inventing a state; the next login and every visit to the settings screen load again.
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
const channelReads = new SvelteMap<string, Promise<boolean>>();
const channelKey = (id: string): string => id.replace(/^channel_/, '');
/** Whether {@link groupLevels} has been answered by the server at least once this session. */
let loaded = $state(false);

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
  const write = writeChain.then(async () => {
    try {
      await saveDisabledCategories(disabled, unknownDisabled, pushEnabled);
      return true;
    } catch (e) {
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

  /** Reads the account's set from the server. Never throws; a failure is logged and keeps the last set. */
  async load(): Promise<boolean> {
    try {
      const snapshot = await fetchNotificationPreferences();
      disabled = snapshot.disabled;
      pushEnabled = snapshot.pushEnabled;
      unknownDisabled = snapshot.unknownDisabled;
      groupLevels = snapshot.groupLevels;
      groupCalls = snapshot.groupCalls;
      loaded = true;
      return true;
    } catch (e) {
      Log.d('notificationPreferences.load failed - keeping the current set', e);
      return false;
    }
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
    try {
      await saveGroupNotificationLevel(groupId, level);
      return true;
    } catch (e) {
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
    try {
      await saveGroupCallsAllowed(groupId, allowed);
      return true;
    } catch (e) {
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
   * Reads a salon's level once (shared in-flight read, cached after). Resolves false - logged, nothing
   * cached, so the next frame asks again - when the read failed. Never throws.
   */
  loadChannelLevel(channelId: string): Promise<boolean> {
    const key = channelKey(channelId);
    const pending = channelReads.get(key);
    if (pending) return pending;
    const read = (async () => {
      try {
        const level = await fetchChannelNotificationLevel(key);
        if (!isConversationNotificationLevel(level)) {
          throw new Error(`unknown salon notification level "${String(level)}"`);
        }
        channelLevels = { ...channelLevels, [key]: level };
        return true;
      } catch (e) {
        Log.d(`notificationPreferences.loadChannelLevel(${key}) failed`, e);
        return false;
      } finally {
        channelReads.delete(key);
      }
    })();
    channelReads.set(key, read);
    return read;
  },

  /** Back to the account default - on sign-out, so the next account never inherits a set. */
  reset(): void {
    disabled = [];
    pushEnabled = [];
    unknownDisabled = [];
    groupLevels = {};
    groupCalls = {};
    channelLevels = {};
    channelReads.clear();
    loaded = false;
  },
};

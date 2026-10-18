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
 * Until the first load answers, everything is ON - the account default - and a failed load says so
 * and keeps that default rather than inventing a state; the next login and every visit to the
 * settings screen load again.
 */
import {
  fetchChannelNotificationLevel,
  fetchNotificationPreferences,
  saveDisabledCategories,
  saveGroupCallsAllowed,
  saveGroupNotificationLevel,
} from '$lib/notifications/preferencesApi';
import { callsAllowedFor } from '$lib/notifications/callPermission';
import type { NotificationCategory } from '$lib/notifications/categories';
import {
  isConversationNotificationLevel,
  type ConversationNotificationLevel,
} from '$lib/notifications/conversationLevel';
import { SvelteMap } from 'svelte/reactivity';
import { Log } from '$lib/utils/Log';

let disabled = $state<NotificationCategory[]>([]);
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

export const notificationPreferences = {
  /** The categories currently switched off. */
  get disabled(): readonly NotificationCategory[] {
    return disabled;
  },

  /** True unless the account switched this category off. */
  isEnabled(category: NotificationCategory): boolean {
    return !disabled.includes(category);
  },

  /** Reads the account's set from the server. Never throws; a failure is logged and keeps the last set. */
  async load(): Promise<boolean> {
    try {
      const snapshot = await fetchNotificationPreferences();
      disabled = snapshot.disabled;
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
   * and returns if the server refuses. Resolves false when the write failed (and was reverted).
   */
  setEnabled(category: NotificationCategory, enabled: boolean): Promise<boolean> {
    const before = disabled;
    const next = enabled
      ? before.filter((c) => c !== category)
      : before.includes(category)
        ? before
        : [...before, category];
    if (next.length === before.length && next.every((c) => before.includes(c))) {
      return Promise.resolve(true);
    }
    disabled = next;
    const write = writeChain.then(async () => {
      try {
        await saveDisabledCategories(next);
        return true;
      } catch (e) {
        Log.d(`notificationPreferences.setEnabled(${category}) failed - reverting`, e);
        // Revert only this switch: a later toggle of another category may already have landed.
        disabled = enabled
          ? disabled.includes(category)
            ? disabled
            : [...disabled, category]
          : disabled.filter((c) => c !== category);
        return false;
      }
    });
    writeChain = write;
    return write;
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

  /** Back to the default (everything on) - on sign-out, so the next account never inherits a set. */
  reset(): void {
    disabled = [];
    groupLevels = {};
    groupCalls = {};
    channelLevels = {};
    channelReads.clear();
    loaded = false;
  },
};

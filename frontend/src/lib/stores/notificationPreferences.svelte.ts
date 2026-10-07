/**
 * Which notification categories this ACCOUNT has switched off, mirrored from the server.
 *
 * NOT `settingsStore`, and that is the point: sound and vibration are per DEVICE in `localStorage`,
 * whereas this follows the account across devices and is the same set the server applies before it
 * sends a push. A client-only copy would leave the server sending what this one hides. The server
 * stays the authority; this store is what the settings screen edits and what the client's own local
 * notifications (raised from a socket frame, where no push is involved) consult.
 *
 * Until the first load answers, everything is ON - the account default - and a failed load says so
 * and keeps that default rather than inventing a state; the next login and every visit to the
 * settings screen load again.
 */
import { fetchDisabledCategories, saveDisabledCategories } from '$lib/notifications/preferencesApi';
import type { NotificationCategory } from '$lib/notifications/categories';
import { Log } from '$lib/utils/Log';

let disabled = $state<NotificationCategory[]>([]);
/** Serialises writes: each PUT carries the whole set, so two in flight could land out of order. */
let writeChain: Promise<unknown> = Promise.resolve();

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
      disabled = await fetchDisabledCategories();
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

  /** Back to the default (everything on) - on sign-out, so the next account never inherits a set. */
  reset(): void {
    disabled = [];
  },
};

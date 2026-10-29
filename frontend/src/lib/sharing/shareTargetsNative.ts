/**
 * The conversations the phone's share sheet SUGGESTS (sharing lot S5): the shortcut id shape, and
 * the two native calls - publish (replace the whole set) and clear - with the one piece of state
 * that makes them idempotent: what the native side was last told. ONE path for both phones, behind
 * the same two commands: Android publishes sharing shortcuts (`ShareTargets.kt`), iOS donates
 * `INSendMessageIntent`s (`ShareSuggestions.swift`).
 *
 * Kept apart from `shareTargets.ts` (which chooses the conversations) because `stores/auth` calls
 * {@link clearShareTargets} at sign-out, and choosing conversations reaches modules that import
 * `stores/auth`. See `docs/wiki/frontend/sharing.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { galleryCommand } from '$lib/services/galleryCommands';
import { isAndroidTauriRuntime, isMobileTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/** Every suggestion's shortcut id is this prefix and a conversation id. */
export const SHARE_TARGET_PREFIX = 'c:';

/**
 * The native side refuses a longer id (`ShareTargets.kt`, `ShareSuggestions.swift`), and the share
 * capture ignores one (`IncomingShare.kt`, the Share Extension's `ShareRules.suggestedTarget`).
 */
const MAX_SHARE_TARGET_ID_LENGTH = 200;

/** A conversation id as it may travel in a shortcut id and a deep link: a plain token. */
const CONVERSATION_ID = /^[A-Za-z0-9_-]+$/;

/** One suggestion as the native side takes it (`publish_share_targets`). */
export interface ShareTarget {
  /**
   * `c:<conversation id>` - what Android hands back as `EXTRA_SHORTCUT_ID`, and iOS as the picked
   * `INSendMessageIntent`'s `conversationIdentifier`.
   */
  id: string;
  /** The conversation's name, as the share picker shows it. */
  label: string;
  /** The deep link a tap from Android's launcher long-press menu opens (iOS has no such menu). */
  link: string;
}

/** The shortcut id of a conversation, or null when its id is not a plain token. */
export function shareTargetId(conversationId: string): string | null {
  const id = `${SHARE_TARGET_PREFIX}${conversationId}`;
  if (!CONVERSATION_ID.test(conversationId) || id.length > MAX_SHARE_TARGET_ID_LENGTH) return null;
  return id;
}

/**
 * The conversation a shortcut id names, or null when it is not of the suggestion shape. Only a
 * HINT: the caller still checks that the signed-in account holds that conversation.
 */
export function conversationIdFromShareTarget(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(SHARE_TARGET_PREFIX)) return null;
  if (value.length > MAX_SHARE_TARGET_ID_LENGTH) return null;
  const conversationId = value.slice(SHARE_TARGET_PREFIX.length);
  return CONVERSATION_ID.test(conversationId) ? conversationId : null;
}

/** What identifies a published set: the ordered ids and labels (the link follows from the id). */
function keyOf(targets: readonly ShareTarget[]): string {
  return JSON.stringify(targets.map((t) => [t.id, t.label]));
}

/** The key of "nothing published" - a clear and a publish of no target leave the same state. */
const NOTHING = keyOf([]);

/**
 * What the native side was last told, as {@link keyOf}; null when unknown (a fresh process, or a
 * call that failed). IDEMPOTENCE COMES FROM THIS, never from a clock: an unchanged list is not
 * sent again, and an unknown state is always sent.
 */
let lastPublished: string | null = null;

/**
 * The calls are applied in the order they were made: a clear at sign-out issued while a publish is
 * in flight must land AFTER it, or the previous account's conversations would be left suggested.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(step: () => Promise<void>): Promise<void> {
  queue = queue.then(step);
  return queue;
}

/**
 * Replaces the suggested conversations with `targets`, most recent first - unless the native side
 * already holds exactly that list. Phone apps only; a failure is said, never thrown.
 */
export function publishShareTargets(targets: ShareTarget[], reason: string): Promise<void> {
  if (!isMobileTauriRuntime()) return Promise.resolve();
  const key = keyOf(targets);
  return enqueue(async () => {
    if (key === lastPublished) return;
    try {
      const answer = await invoke<{ present: number; leftover: number }>(
        galleryCommand('publishShareTargets'),
        { targets }
      );
      // The names are the member's conversations: their count only.
      if (answer.leftover > 0) {
        // Stale suggestions the platform would not remove: what it holds is NOT this list, so
        // the next call is sent whatever it asks for.
        lastPublished = null;
        console.warn(
          `[share-targets] published, but ${answer.leftover} stale suggestion(s) could not be removed (${reason})`
        );
      } else {
        lastPublished = key;
      }
      Log.d('ShareTargets', `${answer.present} of ${targets.length} present (${reason})`);
    } catch (err) {
      lastPublished = null;
      console.error(`[share-targets] the suggestions were not published (${reason})`, err);
    }
  });
}

/**
 * Removes every suggested conversation - when the member turns the suggestions off, and at
 * sign-out through {@link eraseAccountShortcuts} - and RESETS the state, so the next account
 * publishes its own. Skipped when the native side is known to hold nothing, unless `force`: the
 * sign-out always asks, since only the native record knows for certain. Phone apps only; a failure
 * is said, never thrown.
 */
export function clearShareTargets(
  reason: string,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!isMobileTauriRuntime()) return Promise.resolve();
  return enqueue(async () => {
    if (!options.force && lastPublished === NOTHING) return;
    try {
      const removed = await invoke<number>(galleryCommand('clearShareTargets'));
      lastPublished = NOTHING;
      Log.d('ShareTargets', `cleared ${removed} (${reason})`);
    } catch (err) {
      lastPublished = null;
      console.error(`[share-targets] the suggestions were not cleared (${reason})`, err);
    }
  });
}

/**
 * Everything of THIS account the system holds as shortcuts, erased at every sign-out (an account
 * switch included; user, 2026-10-22): the share suggestions, ALWAYS asked of the native side, and
 * on Android the `chat_<group>` conversation shortcuts the message notifications publish (names
 * and faces). iOS has no second set: its notification extension donates no intent and publishes no
 * shortcut, so the suggestions' donations are all the system holds of an account there. Queued
 * after any publish in flight. Phone apps only; a failure is said, never thrown.
 */
export function eraseAccountShortcuts(reason: string): Promise<void> {
  if (!isMobileTauriRuntime()) return Promise.resolve();
  const suggestions = clearShareTargets(reason, { force: true });
  if (!isAndroidTauriRuntime()) return suggestions;
  return enqueue(async () => {
    try {
      const removed = await invoke<number>(galleryCommand('clearConversationShortcuts'));
      Log.d('ShareTargets', `${removed} conversation shortcut(s) erased (${reason})`);
    } catch (err) {
      console.error(`[share-targets] the conversation shortcuts were not erased (${reason})`, err);
    }
  });
}

/** Test seam: forgets what the native side was told, as a fresh process would. */
export function resetShareTargetsStateForTests(): void {
  lastPublished = null;
  queue = Promise.resolve();
}

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

/**
 * WHICH picture a suggestion is drawn with: an id and never a location, the same two routes a
 * push notification's icon may name (`CanariFirebaseMessagingService`): a person's photo through
 * the authenticated avatar route, or a public media object (a group's image, a community's logo).
 * The native side fetches and caches it itself - no bytes cross the bridge.
 */
export interface ShareTargetAvatar {
  kind: 'user' | 'media';
  id: string;
}

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
  /** The picture to draw; absent -> the native side draws the initials of `label`. */
  avatar?: ShareTargetAvatar;
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

/**
 * What identifies a published set: the ordered ids, labels and pictures (the link follows from the
 * id). The picture is part of it, so a changed group image reaches the sheet at the next departure.
 */
function keyOf(targets: readonly ShareTarget[]): string {
  return JSON.stringify(targets.map((t) => [t.id, t.label, t.avatar?.kind, t.avatar?.id]));
}

/**
 * HOW a published set differs from the one before it, in words a log carries: the conversations that
 * entered and left the set (id prefixes - never a name), how many only changed their label, and
 * whether the survivors changed order. Written so a reading of a first sync can tell a set that
 * FLAPS (the same id leaving and returning) from one that only walks forward - the two have
 * different fixes (the order of the list, or publishing from a settled one).
 */
export function describeShareTargetsChange(
  previous: readonly ShareTarget[] | null,
  next: readonly ShareTarget[]
): string {
  if (previous === null) return `first publish after an unknown state, ${next.length} target(s)`;
  const short = (t: ShareTarget): string => t.id.slice(SHARE_TARGET_PREFIX.length).slice(0, 8);
  const before = new Map(previous.map((t) => [t.id, t]));
  const after = new Map(next.map((t) => [t.id, t]));
  const added = next.filter((t) => !before.has(t.id)).map(short);
  const removed = previous.filter((t) => !after.has(t.id)).map(short);
  const relabelled = next.filter(
    (t) => before.get(t.id)?.label !== undefined && before.get(t.id)?.label !== t.label
  ).length;
  const kept = (list: readonly ShareTarget[], other: Map<string, ShareTarget>): string =>
    list
      .filter((t) => other.has(t.id))
      .map((t) => t.id)
      .join(',');
  const reordered = kept(previous, after) !== kept(next, before);
  return `added [${added.join(',')}], removed [${removed.join(',')}], ${relabelled} relabelled, ${reordered ? 'reordered' : 'same order'}`;
}

/** The key of "nothing published" - a clear and a publish of no target leave the same state. */
const NOTHING = keyOf([]);

/**
 * What the native side was last told, as {@link keyOf}; null when unknown (a fresh process, or a
 * call that failed). IDEMPOTENCE COMES FROM THIS, never from a clock: an unchanged list is not
 * sent again, and an unknown state is always sent.
 */
let lastPublished: string | null = null;

/** The set behind {@link lastPublished}, for the log that says how the next publish differs; null when unknown. */
let lastTargets: ShareTarget[] | null = null;

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
    const change = describeShareTargetsChange(lastTargets, targets);
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
        // What THIS call asked for is still the comparison point of the next line.
        lastTargets = targets;
        console.warn(
          `[share-targets] published, but ${answer.leftover} stale suggestion(s) could not be removed (${reason})`
        );
      } else {
        lastPublished = key;
        lastTargets = targets;
      }
      // ONE line per publish, said after the answer: how it differs from the one before, and what the
      // platform lists afterwards.
      Log.i(
        'ShareTargets',
        `published (${reason}): ${change}; ${answer.present} of ${targets.length} present, ${answer.leftover} stale left`
      );
    } catch (err) {
      // `lastTargets` stays: the diff of the next attempt is still against the last set told.
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
      lastTargets = [];
      Log.d('ShareTargets', `cleared ${removed} (${reason})`);
    } catch (err) {
      lastPublished = null;
      lastTargets = null;
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
  lastTargets = null;
  queue = Promise.resolve();
}

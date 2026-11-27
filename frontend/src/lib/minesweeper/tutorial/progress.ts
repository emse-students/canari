import { TUTORIAL_PROGRESS_KEY } from '../settings';
import { ALL_LESSON_IDS } from './path';

/**
 * THE TUTORIAL'S PROGRESS, per DEVICE (owner, 2026-11-27): which lessons were solved, and whether the lamp
 * of the lesson screen was ever used (it pulses until then). A convenience of the hand holding the phone,
 * stored like the other minesweeper settings (`settings.ts`): read synchronously, validated on read, and a
 * value that is not what we wrote is LOGGED AND IGNORED - the path then starts blank, it never breaks.
 *
 * It is a record of what the player did, never a score: no streak, no points, no medals (charter, principle 3
 * - your attention is not for sale). Nothing here reaches the server, the engine or a game.
 */
export { TUTORIAL_PROGRESS_KEY };

export interface TutorialProgress {
  /** The ids of the lessons solved, in the order they were first solved. */
  done: readonly string[];
  /** The lamp of the lesson screen was pressed once: it stops pulsing. */
  lampUsed: boolean;
}

const EMPTY: TutorialProgress = { done: [], lampUsed: false };

/**
 * Reads the stored progress. A value that is not JSON, not an object, or whose fields have the wrong type
 * is logged and read as none; an id that is no lesson any more (the catalogue changed) is dropped, logged.
 */
export function loadTutorialProgress(): TutorialProgress {
  if (typeof localStorage === 'undefined') return EMPTY;
  let raw: unknown;
  try {
    const text = localStorage.getItem(TUTORIAL_PROGRESS_KEY);
    if (text === null) return EMPTY;
    raw = JSON.parse(text);
  } catch (err) {
    console.warn('[minesweeper] stored tutorial progress unreadable, starting blank', err);
    return EMPTY;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn('[minesweeper] stored tutorial progress is not an object, ignored', { raw });
    return EMPTY;
  }
  const stored = raw as Record<string, unknown>;
  if (!Array.isArray(stored.done) || stored.done.some((id) => typeof id !== 'string')) {
    console.warn('[minesweeper] stored tutorial progress has a bad lesson list, ignored', {
      done: stored.done,
    });
    return EMPTY;
  }
  const ids = [...new Set(stored.done as string[])];
  const known = ids.filter((id) => ALL_LESSON_IDS.has(id));
  if (known.length !== ids.length) {
    console.debug('[minesweeper] dropped stored lessons that no longer exist', {
      dropped: ids.filter((id) => !ALL_LESSON_IDS.has(id)),
    });
  }
  return { done: known, lampUsed: stored.lampUsed === true };
}

/** Persists the progress; a storage that refuses (private mode, quota) is logged, never fatal. */
export function saveTutorialProgress(progress: TutorialProgress): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(TUTORIAL_PROGRESS_KEY, JSON.stringify(progress));
  } catch (err) {
    console.warn('[minesweeper] could not store the tutorial progress', err);
  }
}

/** Marks a lesson done (a no-op when it already is) and stores the result; returns the new progress. */
export function markLessonDone(id: string): TutorialProgress {
  const current = loadTutorialProgress();
  if (!ALL_LESSON_IDS.has(id)) {
    console.warn('[minesweeper] cannot mark an unknown lesson done', { id });
    return current;
  }
  if (current.done.includes(id)) return current;
  const next = { ...current, done: [...current.done, id] };
  console.debug('[minesweeper] lesson done', { id, total: next.done.length });
  saveTutorialProgress(next);
  return next;
}

/** Records that the lamp was used once, so it stops pulsing; returns the new progress. */
export function markLampUsed(): TutorialProgress {
  const current = loadTutorialProgress();
  if (current.lampUsed) return current;
  const next = { ...current, lampUsed: true };
  saveTutorialProgress(next);
  return next;
}

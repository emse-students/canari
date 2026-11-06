import { Log } from '$lib/utils/Log';

/** The part of a question the editor copies; everything else on it is carried over untouched. */
interface DuplicableQuestion {
  id: string;
  options?: { id?: string }[];
  rows?: unknown[];
  dependsOn?: string;
  dependsValue?: string;
}

/**
 * Inserts a copy of `items[index]` right after it, and returns the new list and the copy's id.
 *
 * The copy is a deep clone (type, description, options with their prices, required, answer
 * condition, audience condition) under a NEW question id and new option and row ids. The original
 * keeps its id, so every condition in another question that points at it keeps pointing at it.
 *
 * The copy's own answer condition stays valid because its source sits before the original, hence
 * before the copy. One that points at the original itself or at a later question could not be
 * shown (a condition may only read an earlier answer): it is dropped, and the decision is logged.
 */
export function duplicateQuestion<T extends DuplicableQuestion>(
  items: T[],
  index: number
): { items: T[]; copyId: string } | null {
  const original = items[index];
  if (!original) {
    Log.d('questionDuplicate', `nothing to duplicate at index ${index}`);
    return null;
  }
  const copy = JSON.parse(JSON.stringify(original)) as T;
  copy.id = crypto.randomUUID();
  if (copy.options) copy.options = copy.options.map((o) => ({ ...o, id: crypto.randomUUID() }));
  if (Array.isArray(copy.rows)) {
    copy.rows = copy.rows.map((row) =>
      typeof row === 'object' && row !== null ? { ...row, id: crypto.randomUUID() } : row
    );
  }
  if (copy.dependsOn) {
    const sourceIndex = items.findIndex((q) => q.id === copy.dependsOn);
    if (sourceIndex < 0 || sourceIndex >= index) {
      Log.d(
        'questionDuplicate',
        `dropping the copy's answer condition: its source is not before the original`
      );
      copy.dependsOn = '';
      copy.dependsValue = '';
    }
  }
  const next = [...items];
  next.splice(index + 1, 0, copy);
  return { items: next, copyId: copy.id };
}

/**
 * The first question that makes a save refuse, so the editor can open it: one whose audience
 * condition is switched on and empty, or - when the form refuses on its file question - the first
 * FILE question. Null when no question is to blame.
 */
export function firstQuestionAtFault(
  items: { id: string; type?: string; showIf?: object | null }[],
  fileProblem: boolean
): string | null {
  const empty = items.find((q) => q.showIf != null && Object.keys(q.showIf).length === 0);
  if (empty) return empty.id;
  if (fileProblem) return items.find((q) => q.type === 'file')?.id ?? null;
  return null;
}

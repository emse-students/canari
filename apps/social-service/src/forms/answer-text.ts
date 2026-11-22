/**
 * ONE ANSWER, ONE STRING - the reading the screen shows and the reading the export writes.
 *
 * A submitted answer is stored as whatever its question type produced: a string, a number, an array
 * of option ids, or, for a matrix, an object keyed by row label. None of those is readable on its
 * own, and an option id is not even a word - the labels live on the QUESTION, so a value can only be
 * read with its item in hand.
 *
 * THIS FILE IS COPIED, BYTE FOR BYTE, between the frontend and social-service, and the copy is
 * declared in `.github/scripts/lib/declared-duplicates.mjs` so a gate refuses the two drifting
 * apart. It is copied rather than shared because there is no TS library between `frontend/` and
 * `apps/`: the one that existed was deleted on 2026-08-27 for being imported by nothing, and
 * bringing it back would add a build stage to a production image to carry sixty lines.
 *
 * It is the answer to ONE question - "what did this person say" - asked in two places: the manager
 * reading a response on the forms list, and the same manager reading the XLSX an hour later. Those
 * two must not be able to disagree, which is the whole reason the copy is policed instead of
 * tolerated.
 *
 * The types are declared HERE, as the minimum shape this reader needs, rather than imported from
 * either side's model. That is what lets the two copies be identical, and it is also the honest
 * dependency: reading an answer needs a question's options and nothing else about it.
 */

/** One selectable option of a question. `id` is optional - an older form stores the label itself. */
export interface AnswerOption {
  id?: string;
  label: string;
  /**
   * The "Autre : precisez" option of a choice question: picking it lets the person type what they
   * mean, kept beside the answer under {@link otherKey} and read here as `Autre: what they typed`.
   */
  other?: boolean;
}

/** The only part of a question this reader needs. */
export interface AnswerQuestion {
  /** Read for a priced grid, to find its lines among the answer's. */
  id?: string;
  options?: AnswerOption[];
  /** Read for `file`, whose stored value is an id, and for `product_grid`. */
  type?: string;
  /** A priced grid's axes: its answer is keyed `rowId:colId`, and these name the ids. */
  productGrid?: { rows: AnswerOption[]; columns: AnswerOption[] };
  /** A choice question that takes a free comment beside its answer (read under {@link commentKey}). */
  allowComment?: boolean;
}

/**
 * THE TWO FREE TEXTS A CHOICE ANSWER MAY CARRY, kept in the answer record beside it under a key
 * derived from the question's id - never inside the choice's own value, which stays an option id
 * (or a list of them) so every reader of a choice (pricing, conditions, results) is untouched.
 *
 * `<id>#other` is what was typed when the "Autre" option was picked; `<id>#comment` is the optional
 * free comment of a question that allows one. Both are plain strings of at most the text bound.
 * They are NOT questions: `answerSelections` (conditions) never sees them, and a reader that walks
 * the form's items finds them only through these helpers.
 */
export const ANSWER_OTHER_SUFFIX = '#other';
export const ANSWER_COMMENT_SUFFIX = '#comment';

/** The record key holding the text typed beside the "Autre" option of question `itemId`. */
export function otherKey(itemId: string): string {
  return `${itemId}${ANSWER_OTHER_SUFFIX}`;
}

/** The record key holding the free comment of question `itemId`. */
export function commentKey(itemId: string): string {
  return `${itemId}${ANSWER_COMMENT_SUFFIX}`;
}

/** The question and the kind of text a record key stands for, or null for an ordinary key. */
export function noteKeyOwner(key: string): { itemId: string; kind: 'other' | 'comment' } | null {
  for (const [suffix, kind] of [
    [ANSWER_OTHER_SUFFIX, 'other'],
    [ANSWER_COMMENT_SUFFIX, 'comment'],
  ] as const) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      return { itemId: key.slice(0, -suffix.length), kind };
    }
  }
  return null;
}

/** A stored free text, trimmed: empty when it is absent or not a string. */
function noteText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The free comment of one question, as text - empty when none was given. */
export function commentText(
  answers: Record<string, unknown> | null | undefined,
  itemId: string
): string {
  return noteText(answers?.[commentKey(itemId)]);
}

/** The text typed beside the "Autre" option of one question - empty when none was given. */
export function otherText(
  answers: Record<string, unknown> | null | undefined,
  itemId: string
): string {
  return noteText(answers?.[otherKey(itemId)]);
}

/**
 * One ordered cell of a priced grid AS CHARGED (`submissions.lines`): read before the grid itself,
 * so an answer says what was ordered even after the creator renamed or deleted a row.
 */
export interface AnswerGridLine {
  itemId: string;
  rowLabel: string;
  colLabel: string;
  quantity: number;
}

/**
 * The words a FILE answer is read with, supplied by the caller that has a language: Paraglide on the
 * screen, the client's export labels on the server. A file answer stores an opaque id, which is not a
 * reading of anything, so it reads as one of two words and never as the id.
 */
export interface AnswerWords {
  /** What a file that is still kept reads as. */
  file: string;
  /** What a file the retention purge has deleted reads as - the answer itself stays. */
  fileDeleted: string;
  /** The file ids that have been purged. */
  deletedFiles: ReadonlySet<string>;
}

/**
 * Resolves a stored value to the option label it names, or returns it unchanged. The "Autre" option
 * reads `Autre: what was typed` when something was typed.
 */
function optionLabel(
  value: string,
  options: AnswerOption[] | undefined,
  other: string | undefined
): string {
  if (!options?.length) return value;
  const option = options.find((candidate) => candidate.id === value);
  if (!option) return value;
  return option.other && other ? `${option.label}: ${other}` : option.label;
}

/** One value of any question type: an option id, a free string, a scale number, or a list of them. */
function oneValue(value: unknown, options: AnswerOption[] | undefined, other?: string): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => oneValue(entry, options, other))
      .filter((entry) => entry !== '')
      .join(', ');
  }
  return optionLabel(String(value), options, other);
}

/** One ordered cell: `Vert / M x2`. */
function gridCellText(rowLabel: string, colLabel: string, quantity: number): string {
  return `${rowLabel} / ${colLabel} x${quantity}`;
}

/** A priced grid's answer: its charged lines when the answer has them, else the grid's labels. */
function gridText(
  answer: unknown,
  item: AnswerQuestion,
  lines: readonly AnswerGridLine[] | null | undefined
): string {
  const charged = (lines ?? []).filter((line) => line.itemId === item.id);
  if (charged.length > 0) {
    return charged.map((l) => gridCellText(l.rowLabel, l.colLabel, l.quantity)).join('; ');
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return '';
  const label = (axis: AnswerOption[] | undefined, id: string) =>
    axis?.find((entry) => entry.id === id)?.label ?? id;
  return Object.entries(answer as Record<string, unknown>)
    .filter(([, quantity]) => typeof quantity === 'number' && quantity > 0)
    .map(([key, quantity]) => {
      const cut = key.indexOf(':');
      const row = label(item.productGrid?.rows, key.slice(0, cut));
      const col = label(item.productGrid?.columns, key.slice(cut + 1));
      return gridCellText(row, col, quantity as number);
    })
    .join('; ');
}

/**
 * The submitter's answer to one question, as text - empty when they did not answer it.
 *
 * A matrix becomes `row: value` pairs separated by `;`. The export shipped with `JSON.stringify`
 * there, which put `{"Lundi":"Oui"}` in a spreadsheet cell for every matrix question ever asked.
 *
 * The punctuation is structural and deliberately NOT a localized message: it joins data, and the
 * two copies of this file have to produce the same bytes to be comparable at all.
 *
 * A zero is an ANSWER - a scale can be answered 0 - so emptiness is tested for as null or the empty
 * string, never by falsiness. The export read `if (!ans)` until 2026-09-20 and dropped those.
 *
 * A FILE answer reads as `words.file` or `words.fileDeleted`, never as its id. A caller that reads
 * one without supplying the words is a defect, and it THROWS rather than printing the id.
 *
 * A PRICED GRID (`product_grid`) reads `Vert / M x2; Noir / L x1`, from `lines` - what was charged -
 * when the caller has them, else from the grid's own labels.
 *
 * `other` is the text typed beside the "Autre" option ({@link otherText}): the option then reads
 * `Autre: that text`. The free COMMENT is not part of this reading - it has a column or a line of
 * its own ({@link commentText}).
 */
export function answerText(
  answer: unknown,
  item: AnswerQuestion,
  words?: AnswerWords,
  lines?: readonly AnswerGridLine[] | null,
  other?: string
): string {
  if (answer == null || answer === '') return '';

  if (item.type === 'product_grid') return gridText(answer, item, lines);

  if (item.type === 'file') {
    if (!words) throw new Error('answerText: a file answer is read with the words of its reader');
    return words.deletedFiles.has(String(answer)) ? words.fileDeleted : words.file;
  }

  if (typeof answer === 'object' && !Array.isArray(answer)) {
    return Object.entries(answer as Record<string, unknown>)
      .map(([row, value]) => {
        const text = oneValue(value, item.options);
        return text === '' ? '' : `${row}: ${text}`;
      })
      .filter((line) => line !== '')
      .join('; ');
  }

  return oneValue(answer, item.options, other);
}

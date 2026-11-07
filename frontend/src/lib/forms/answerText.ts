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

/** Resolves a stored value to the option label it names, or returns it unchanged. */
function optionLabel(value: string, options: AnswerOption[] | undefined): string {
  if (!options?.length) return value;
  return options.find((option) => option.id === value)?.label ?? value;
}

/** One value of any question type: an option id, a free string, a scale number, or a list of them. */
function oneValue(value: unknown, options: AnswerOption[] | undefined): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => oneValue(entry, options))
      .filter((entry) => entry !== '')
      .join(', ');
  }
  return optionLabel(String(value), options);
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
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return '';
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
 */
export function answerText(
  answer: unknown,
  item: AnswerQuestion,
  words?: AnswerWords,
  lines?: readonly AnswerGridLine[] | null
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

  return oneValue(answer, item.options);
}

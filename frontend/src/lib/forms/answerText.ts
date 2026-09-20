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
  options?: AnswerOption[];
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
 */
export function answerText(answer: unknown, item: AnswerQuestion): string {
  if (answer == null || answer === '') return '';

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

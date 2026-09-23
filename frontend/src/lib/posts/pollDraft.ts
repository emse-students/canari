/**
 * A POLL BEING WRITTEN, AND THE THREE RULES THAT DECIDE WHETHER IT CAN BE SENT.
 *
 * The post composer held its options as ONE STRING with a newline between each - a textarea
 * labelled "Options (une par ligne)". Nothing about a text box says that a line break is
 * structural, so "Oui, Non" was one option, the publish was refused, and on `0.18.14` the refusal
 * said only "Impossible de publier le post" (user, 2026-09-21; the stage was confirmed as `poll`
 * on 2026-09-23). The channel composer had had one input per option, a `+` and a bin since it was
 * written, so the app already contained the answer and the post surface did not.
 *
 * The options are therefore `string[]` everywhere from here on, and `PollOptionsEditor.svelte` is
 * the ONE editor both surfaces mount. What survives of the old shape is the draft in
 * `localStorage`, which is migrated on read rather than versioned - see `postComposerDraft.ts`.
 *
 * MAX SELECTIONS IS A RULE, NOT A DECORATION, so it is stated here and enforced in three places
 * that must agree: this module refuses to compose a poll that contradicts itself,
 * {@link nextPollSelection} refuses to select past it on the device, and
 * `post-interactions.service.ts` refuses to RECORD past it - the only one of the three that is not
 * advisory, and the one that did not exist at all before 2026-09-23. A cap only the client applies
 * is a cap a crafted request ignores, and `multipleChoice` itself had exactly that hole.
 */

/** A poll needs at least this many options to be a question rather than a statement. */
export const POLL_MIN_OPTIONS = 2;
/** The cap the channel composer has always applied, now applied on both surfaces. */
export const POLL_MAX_OPTIONS = 10;

/**
 * One option being written: an IDENTITY and a label.
 *
 * The label is not the option. Two rows may be blank at once while the reader types, a rename is
 * not a replacement, and - the reason this is a type rather than a string - **a vote is cast
 * against an id**. The edit form sends these ids back, so an option that survives an edit keeps
 * its tally; `posts.service.ts` matches on them, and before they existed every save minted new
 * ones and emptied the poll.
 */
export interface PollDraftOption {
  /** Stable for the life of the row, and for the life of the option once it has been saved. */
  id: string;
  label: string;
}

/** A blank row, with the identity it will keep. */
export function newPollOption(label = ''): PollDraftOption {
  return { id: crypto.randomUUID(), label };
}

/** The rows a new poll opens with: two, because a poll with one option is not a poll. */
export function emptyPollOptions(): PollDraftOption[] {
  return [newPollOption(), newPollOption()];
}

/** A poll as the composer holds it. */
export interface PollDraft {
  question: string;
  /** One entry per row of the editor, blanks included - the reader may be mid-typing. */
  options: PollDraftOption[];
  multipleChoice: boolean;
  /**
   * How many options one voter may pick, or `null` for no limit.
   *
   * Only meaningful when {@link PollDraft.multipleChoice} is set: a single-choice poll is already
   * capped at one, and carrying a second number saying so would be two sources for one rule.
   */
  maxSelections: number | null;
  /** `datetime-local` value, or `''` for a poll that does not close. */
  endsAt: string;
}

/** Why a poll draft cannot be sent - one value per thing the reader must do about it. */
export type PollDraftIssue = 'question' | 'options' | 'maxSelections' | 'endsAt';

/**
 * The options that will actually be sent: trimmed, blanks dropped, in the order typed.
 *
 * A blank row is not an error - it is an empty input the reader has not filled yet, and refusing
 * it would mean a poll cannot be built by adding three rows and filling them in any order.
 *
 * @param options The rows as typed.
 * @returns The non-blank options, labels trimmed, ids untouched.
 */
export function filledPollOptions(options: PollDraftOption[]): PollDraftOption[] {
  return options.map((o) => ({ ...o, label: o.label.trim() })).filter((o) => o.label);
}

/**
 * The cap as it should be STORED, given what the rest of the draft says.
 *
 * A cap is dropped when it cannot mean anything: no multiple choice, no cap; a cap at or above the
 * number of options is "all of them", which is the same as no cap and must not be written as a
 * number that a later edit would turn into a real limit by removing an option.
 *
 * @param maxSelections The number the reader chose, or `null`.
 * @param optionCount How many filled options the poll has.
 * @param multipleChoice Whether more than one answer is allowed at all.
 * @returns The cap to send, or `null` when there is none.
 */
export function normalizeMaxSelections(
  maxSelections: number | null,
  optionCount: number,
  multipleChoice: boolean
): number | null {
  if (!multipleChoice || maxSelections === null) return null;
  if (!Number.isInteger(maxSelections) || maxSelections < POLL_MIN_OPTIONS) return null;
  return maxSelections >= optionCount ? null : maxSelections;
}

/**
 * The first thing wrong with this poll, or `null` when it can be sent.
 *
 * @param draft The poll as the composer holds it.
 * @param storedEndsAt The deadline this poll ALREADY had, when editing one - see below.
 * @returns The issue the reader must resolve, or `null`.
 */
export function pollDraftIssue(draft: PollDraft, storedEndsAt = ''): PollDraftIssue | null {
  if (!draft.question.trim()) return 'question';
  if (filledPollOptions(draft.options).length < POLL_MIN_OPTIONS) return 'options';
  // A cap ABOVE the option count is harmless and normalises away; a cap below two would make a
  // multiple-choice poll single-choice by another name, which is a contradiction the reader wrote
  // and must see rather than have silently rewritten.
  if (
    draft.multipleChoice &&
    draft.maxSelections !== null &&
    draft.maxSelections < POLL_MIN_OPTIONS
  ) {
    return 'maxSelections';
  }
  // A DEADLINE THE READER DID NOT TOUCH IS NOT A DEADLINE THE READER IS SETTING. The edit form
  // loads a poll that may have closed long ago; judging that field as if it had just been typed
  // would make an old poll uneditable, and the reader would be refused over a date they never
  // wrote. Only a CHANGED deadline has to be ahead of us.
  if (draft.endsAt && draft.endsAt !== storedEndsAt && !isFuture(draft.endsAt)) return 'endsAt';
  return null;
}

/** Whether a `datetime-local` value parses and is still ahead of us. */
function isFuture(value: string): boolean {
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

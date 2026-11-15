import { BadRequestException, Logger } from '@nestjs/common';

const logger = new Logger('PostAttachedForm');

/**
 * An anonymous post carries no form (decided by the lead, 2026-11-14, reversible): a form names who
 * manages it, and a personal post may only attach a form its author manages, so the form would
 * narrow down the author the post hides. Refused at create, and at an edit that attaches one.
 */
export const FORM_NOT_ON_ANONYMOUS_POST = 'FORM_NOT_ON_ANONYMOUS_POST';

/**
 * The inline `forms` list of a post being created is retired: no client of this repository ever
 * wrote it (the composer has sent `attachedFormId` since its first version, 2026-03), so it is
 * refused rather than stored as sent with titles nobody checked.
 */
export const POST_FORMS_RETIRED = 'POST_FORMS_RETIRED';

/** Refuses (400 `POST_FORMS_RETIRED`) a creation naming a non-empty `forms` list. */
export function assertNoInlineFormsList(forms: unknown): void {
  if (forms === undefined || forms === null) return;
  if (Array.isArray(forms) && forms.length === 0) return;
  logger.warn('[POSTS] create refused: the retired inline forms list was sent');
  throw new BadRequestException({
    code: POST_FORMS_RETIRED,
    message: 'A post attaches its form by attachedFormId',
  });
}

/** Refuses (400 `FORM_NOT_ON_ANONYMOUS_POST`) an anonymous post attaching a form. */
export function assertNoFormOnAnonymousPost(
  anonymous: boolean | undefined,
  formId: string | null | undefined
): void {
  if (!anonymous || !formId) return;
  logger.log(`[POSTS] attach refused: form ${formId.slice(0, 8)} on an anonymous post`);
  throw new BadRequestException({
    code: FORM_NOT_ON_ANONYMOUS_POST,
    message: 'An anonymous post carries no form',
  });
}

/**
 * Withholds the forms of an anonymous post from a reader its author is hidden from - the read side
 * of {@link FORM_NOT_ON_ANONYMOUS_POST}, for a post stored before the refusal (no row is rewritten).
 * Called on the same branch that strips `authorId`, so the author and moderators still see it.
 */
export function withholdFormsOfHiddenAuthor(out: Record<string, unknown>): void {
  if (out.attachedFormId) logger.debug('[POSTS] anonymous post: its form withheld from the reader');
  delete out.attachedFormId;
  if (out.forms !== undefined) out.forms = [];
}

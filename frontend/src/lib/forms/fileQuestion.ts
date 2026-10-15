import { m } from '$lib/paraglide/messages';
import { MEDIA_REQUEST_BODY_BUDGET_BYTES } from '$lib/utils/mediaRequestLimits';

/**
 * THE FILE QUESTION, CLIENT SIDE: the limits the page checks before it uploads anything, and the
 * two settings a file question shuts.
 *
 * The server is the gate for every one of these (`apps/social-service/src/forms/form-files.service.ts`
 * reads the type from the bytes and refuses the rest); they are repeated here so a member is told in
 * their own language BEFORE ten megabytes travel, not after. The numbers are the server's.
 */

/** The question type whose answer is a file. */
export const FILE_QUESTION_TYPE = 'file';

/**
 * The server's cap on one answer's file: the 8 MiB single-request budget, because the file travels
 * in ONE request and the host WAF drops a body over 10 MiB without an answer.
 */
export const FORM_FILE_MAX_BYTES = MEDIA_REQUEST_BODY_BUDGET_BYTES;

/** The types the server accepts, as a file picker's `accept` and as the pre-upload check. */
export const FORM_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** `forms.fileRetentionDays`: its range and its default (decisions D23, D41). */
export const FILE_RETENTION_MIN_DAYS = 1;
export const FILE_RETENTION_MAX_DAYS = 30;
export const FILE_RETENTION_DEFAULT_DAYS = 7;

/** Whether a form's questions ask for a file. */
export function hasFileQuestion(items: ReadonlyArray<{ type?: string }>): boolean {
  return items.some((item) => item.type === FILE_QUESTION_TYPE);
}

/** Whether a retention value is one the server accepts: a whole number of days, 1 to 30. */
export function isValidFileRetention(days: unknown): days is number {
  return (
    typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= FILE_RETENTION_MIN_DAYS &&
    days <= FILE_RETENTION_MAX_DAYS
  );
}

/**
 * Why this form cannot be saved because of a file question, in the reader's language - or null.
 * The same refusals the server makes (`assertPublicConfigValid`, `assertAnonymousConfigValid`), and
 * the retention range the database holds.
 */
export function fileQuestionProblem(form: {
  items: ReadonlyArray<{ type?: string }>;
  isPublic: boolean;
  anonymous: boolean;
  fileRetentionDays: unknown;
}): string | null {
  if (!hasFileQuestion(form.items)) return null;
  if (form.isPublic) return m.form_public_hint_blocked_file();
  if (form.anonymous) return m.form_anonymous_hint_file();
  if (!isValidFileRetention(form.fileRetentionDays)) return m.form_file_retention_invalid();
  return null;
}

/** Why a picked file will not be sent, in the reader's language - or null when it may be. */
export function pickedFileProblem(file: { size: number; type: string }): string | null {
  if (!FORM_FILE_TYPES.includes(file.type)) return m.form_file_error_type();
  if (file.size > FORM_FILE_MAX_BYTES) return m.form_file_error_size();
  return null;
}

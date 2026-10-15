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

/** The types the server accepts (it reads them from the bytes), as the pre-upload check. */
export const FORM_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** The type each accepted extension names - what a file with no declared type is judged by. */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * The picker's `accept`: the MIME types AND the extensions. Some Android pickers filter by
 * extension only and hand over a file with an EMPTY `type`, so both are listed.
 */
export const FORM_FILE_ACCEPT = [
  ...FORM_FILE_TYPES,
  ...Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`),
].join(',');

/** HEIC/HEIF - an iPhone's own photo format - which the server does not take. */
const HEIC = /^image\/hei[cf](-sequence)?$/;
const HEIC_EXTENSION = /\.hei[cf]$/i;

/**
 * The type a picked file is judged by: its declared `type`, or - when the platform declared none
 * (an Android picker, `type === ''`) - the type its EXTENSION names. The server reads the real type
 * from the bytes either way; this decides only which sentence the member reads before sending.
 */
export function pickedFileType(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  return EXTENSION_TYPES[ext] ?? '';
}

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
 * The same refusals the server makes (`assertPublicConfigValid`, `assertAnonymousConfigValid`,
 * `assertFileQuestionConfigValid`), and the retention range the database holds.
 *
 * An ANSWER criterion on who may submit is refused: the file is uploaded before any answer exists,
 * and the upload is judged on that same condition, so every upload would be refused.
 */
export function fileQuestionProblem(form: {
  items: ReadonlyArray<{ type?: string }>;
  isPublic: boolean;
  anonymous: boolean;
  fileRetentionDays: unknown;
  submitCondition?: { answer?: unknown } | null;
}): string | null {
  if (!hasFileQuestion(form.items)) return null;
  if (form.isPublic) return m.form_public_hint_blocked_file();
  if (form.anonymous) return m.form_anonymous_hint_file();
  if (form.submitCondition?.answer != null) return m.form_file_submit_condition_answer();
  if (!isValidFileRetention(form.fileRetentionDays)) return m.form_file_retention_invalid();
  return null;
}

/**
 * Why a picked file will not be sent, in the reader's language - or null when it may be.
 *
 * HEIC is REFUSED with its own sentence (convert it, or send a screenshot/PDF), not converted here:
 * a WebView decodes HEIC only on Apple's engine, so a conversion would work on one phone in two. iOS
 * itself hands over a JPEG when the picker asks for one, which `accept` does.
 */
export function pickedFileProblem(file: {
  name: string;
  size: number;
  type: string;
}): string | null {
  if (HEIC.test(file.type) || HEIC_EXTENSION.test(file.name)) return m.form_file_error_heic();
  if (!FORM_FILE_TYPES.includes(pickedFileType(file))) return m.form_file_error_type();
  if (file.size > FORM_FILE_MAX_BYTES) return m.form_file_error_size();
  return null;
}

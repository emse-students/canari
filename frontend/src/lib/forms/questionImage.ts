import { m } from '$lib/paraglide/messages';
import { compressImage, IMAGE_COMPRESS_PRESETS } from '$lib/media';
import { SocialApiError } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';

/**
 * A form question's image (owner, 2026-11-06): a PUBLIC picture, so a guest on a public form reads
 * it with no session. The server stores it at the 1600 px `content` bound; the device sends it at
 * the post preset first, so a phone photo travels as a few hundred kilobytes rather than megabytes.
 * See docs/wiki/frontend/modules/forms.md ("A question's image").
 */

/** The types the media service's public route decodes - anything else is refused there. */
export const QUESTION_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

/** media-service's `PUBLIC_LOGO_MAX_BYTES`: the public route's ceiling for one image. */
export const QUESTION_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** The server's refusal of a save citing an image that was not uploaded for this form. */
export const QUESTION_IMAGE_NOT_YOURS = 'QUESTION_IMAGE_NOT_YOURS';

/** The picked file is still over {@link QUESTION_IMAGE_MAX_BYTES} once resized. */
export class QuestionImageTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`question image is ${sizeBytes} bytes after resizing`);
    this.name = 'QuestionImageTooLargeError';
  }
}

/** The picked file is not one of {@link QUESTION_IMAGE_ACCEPT}. */
export class QuestionImageTypeError extends Error {
  constructor(readonly mimeType: string) {
    super(`question image type ${mimeType || 'unknown'} is not accepted`);
    this.name = 'QuestionImageTypeError';
  }
}

/**
 * The file a question image is uploaded as: resized and re-encoded with the post preset
 * (`IMAGE_COMPRESS_PRESETS.post`), the preset every feed photo uses. Throws a typed error for a type
 * the server would refuse or a result still over its ceiling, so the editor says why in words.
 */
export async function prepareQuestionImage(file: File): Promise<File> {
  if (!QUESTION_IMAGE_ACCEPT.split(',').includes(file.type)) {
    throw new QuestionImageTypeError(file.type);
  }
  const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.post;
  const { file: prepared } = await compressImage(file, maxWidth, maxHeight, quality);
  Log.d('FORMS', `question image prepared: ${file.size} -> ${prepared.size} bytes`);
  if (prepared.size > QUESTION_IMAGE_MAX_BYTES) {
    throw new QuestionImageTooLargeError(prepared.size);
  }
  return prepared;
}

/** The sentence the editor shows for a failed question image upload, from the error's TYPE. */
export function questionImageUploadError(err: unknown): string {
  if (err instanceof QuestionImageTypeError) return m.form_builder_image_type_refused();
  if (err instanceof QuestionImageTooLargeError) return m.form_builder_image_too_large();
  if (err instanceof SocialApiError && err.status === 413) return m.form_builder_image_too_large();
  return m.form_builder_image_upload_failed();
}

/** The sentence for a save refused over a question's image, or null when `err` is anything else. */
export function questionImageRefusalMessage(err: unknown): string | null {
  return err instanceof SocialApiError && err.code === QUESTION_IMAGE_NOT_YOURS
    ? m.form_question_image_not_yours()
    : null;
}

/**
 * The text alternative of a question's image: the one its author wrote, or one naming the question
 * - never empty, because a question's picture usually carries what the question asks about.
 */
export function questionImageAlt(item: { label?: string; imageAlt?: string }): string {
  const written = item.imageAlt?.trim();
  if (written) return written;
  return m.form_question_image_alt({ label: item.label?.trim() || m.form_question_untitled() });
}

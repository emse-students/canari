import { BadRequestException, Logger } from '@nestjs/common';

const logger = new Logger('AssociationImageUrl');

/** The stable code the client maps to its own sentence. */
export const ASSOCIATION_IMAGE_URL_CODE = 'ASSOCIATION_IMAGE_URL_INVALID';

/** Longest value accepted; a real logo URL is a fraction of this. */
export const ASSOCIATION_IMAGE_URL_MAX_LENGTH = 2048;

/**
 * The one shape this service writes itself: `setLogoFromUpload` stores
 * `/api/media/public/<media id>?v=<timestamp>`. Anchored at both ends, so nothing can ride after it.
 */
const OWN_MEDIA_REFERENCE = /^\/api\/media\/public\/[A-Za-z0-9-]{1,64}(\?v=[0-9]{1,20})?$/;

/**
 * Characters no image URL needs and that end an HTML attribute or a tag: refused in the RAW string,
 * because the stored value is the raw string and not what `new URL` would normalise it into.
 */
const MARKUP_OR_SPACE = /[\s"'<>`\\]/;

/**
 * Whether `value` may be stored as an association image URL (`logoUrl`).
 *
 * AN ALLOWLIST, NOT A DENYLIST: our own public-media reference, or an absolute `https:` URL with no
 * markup or whitespace in it. Everything else - other schemes (`javascript:`, `data:`, `http:`),
 * protocol-relative and other relative paths, and any value carrying quotes or angle brackets - is
 * refused. The value is drawn by every client that shows the association, so it is checked once,
 * where it is written.
 */
export function isAllowedAssociationImageUrl(value: string): boolean {
  if (value.length > ASSOCIATION_IMAGE_URL_MAX_LENGTH) return false;
  if (OWN_MEDIA_REFERENCE.test(value)) return true;
  if (MARKUP_OR_SPACE.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && value.toLowerCase().startsWith('https://');
}

/**
 * Throws `400 ASSOCIATION_IMAGE_URL_INVALID` when `value` is not an allowed association image URL
 * (see {@link isAllowedAssociationImageUrl}). Callers handle blank-means-clear before calling.
 */
export function assertAssociationImageUrl(value: string): void {
  if (isAllowedAssociationImageUrl(value)) return;
  logger.warn(
    `[ASSOCIATION] refused an image URL that is neither an own media reference nor https (length ${value.length})`
  );
  throw new BadRequestException({
    code: ASSOCIATION_IMAGE_URL_CODE,
    message: 'An association image URL must be an https URL or an uploaded media reference.',
  });
}

/** The code of a logo naming a form question's image (`form_item_images`, migration 136). */
export const ASSOCIATION_IMAGE_QUESTION_IMAGE_CODE = 'ASSOCIATION_IMAGE_IS_QUESTION_IMAGE';

const PUBLIC_MEDIA_PATH =
  /^\/api\/media\/public\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The media id an image URL names through the public media route - our own reference
 * (`/api/media/public/<id>?v=...`) or an absolute URL of any host whose PATH is that route - or null.
 */
export function publicMediaIdOf(value: string): string | null {
  let path: string;
  try {
    path = new URL(value, 'https://relative.invalid').pathname;
  } catch {
    return null;
  }
  const match = PUBLIC_MEDIA_PATH.exec(path);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Throws `400 ASSOCIATION_IMAGE_IS_QUESTION_IMAGE` when `value` names an image uploaded for a form
 * question. Such an image is deleted once no FORM cites it (`form-item-images.service.ts`, which
 * reads `forms` only), so a logo pointing at one would vanish with that form's question. No lock:
 * a row is written right after its upload, before its URL is handed to anyone, so an id that is a
 * question image has had its row since before anybody could paste it.
 */
export async function assertNotQuestionImage(
  db: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  value: string
): Promise<void> {
  const mediaId = publicMediaIdOf(value);
  if (mediaId === null) return;
  const rows = (await db.query(`SELECT 1 FROM form_item_images WHERE "mediaId" = $1`, [
    mediaId,
  ])) as unknown[];
  if (rows.length === 0) return;
  logger.warn(
    `[ASSOCIATION] refused a logo naming question image media=${mediaId.slice(0, 8)} - it would be deleted with its form`
  );
  throw new BadRequestException({
    code: ASSOCIATION_IMAGE_QUESTION_IMAGE_CODE,
    message: "An association image may not be a form question's image.",
  });
}

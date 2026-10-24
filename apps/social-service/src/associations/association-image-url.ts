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

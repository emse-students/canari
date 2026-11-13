import { BadRequestException } from '@nestjs/common';

/**
 * A DISPLAY name - a salon's, a community's: stored exactly as typed (case, accents, emoji,
 * spaces), and never an identifier. Only what would break the row that draws it is refused:
 * nothing once trimmed, longer than `max` characters a person sees (code points, not UTF-16
 * units), or a control character.
 *
 * @param what - the word the refusal names the thing by ("Channel", "Community")
 * @param code - the stable code the refusal carries, for a client that names it to its user
 * @returns the trimmed name
 * @throws BadRequestException for a name that is not one
 */
export function validateDisplayName(
  raw: unknown,
  max: number,
  what: string,
  code?: string
): string {
  const refuse = (message: string) => new BadRequestException(code ? { code, message } : message);
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw refuse(`${what} name cannot be empty`);
  if (Array.from(name).length > max) throw refuse(`${what} name too long (max ${max} characters)`);
  if (/\p{Cc}/u.test(name)) throw refuse(`${what} name cannot contain control characters`);
  return name;
}

/** Longest community name - the creation form's `maxlength` (`COMMUNITY_NAME_MAX_LENGTH` on the client). */
export const MAX_COMMUNITY_NAME_LENGTH = 80;

/** Longest slug a client asks for - what the client's `slugify(name, 48)` produces at most. */
export const MAX_COMMUNITY_SLUG_LENGTH = 48;

/** A community's name as it is stored: {@link validateDisplayName} at {@link MAX_COMMUNITY_NAME_LENGTH}. */
export function validateCommunityName(raw: unknown): string {
  return validateDisplayName(raw, MAX_COMMUNITY_NAME_LENGTH, 'Community', 'COMMUNITY_NAME_INVALID');
}

/**
 * The slug a creation asks for, which becomes part of an address: lowercase ASCII letters and
 * digits in groups joined by single hyphens, at most {@link MAX_COMMUNITY_SLUG_LENGTH} - exactly
 * what every client derives from the name (`slugify`, `frontend/src/lib/utils/textFold.ts`).
 * The server may then append `-2`, `-3`... to make it unique.
 *
 * @throws BadRequestException for anything else
 */
export function validateCommunitySlug(raw: unknown): string {
  const slug = typeof raw === 'string' ? raw.trim() : '';
  if (slug.length > MAX_COMMUNITY_SLUG_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new BadRequestException({
      code: 'COMMUNITY_SLUG_INVALID',
      message: 'Community slug is not valid',
    });
  }
  return slug;
}

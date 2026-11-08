/**
 * THE LIMITS OF A PER-CONVERSATION NICKNAME, the client's half of
 * `libs/contracts/conversation-nickname.json` (social-service holds the other half, and each side's
 * spec walks the contract's cases).
 *
 * Mirrors the profile's name fields, as the owner decided (2026-10-14): NFKC, every control and
 * format character dropped (a zero-width space or a bidi override would let a nickname impersonate
 * another member's name), trimmed, at most {@link NICKNAME_MAX_LENGTH} code points. A value empty
 * once normalized is a RESET - no nickname - never an empty label.
 *
 * Run on the way OUT (the screen, before a frame is queued or a request sent) and on the way IN
 * (every MLS frame and bundle entry): an MLS group has no server to refuse a malformed value, so a
 * peer's frame is held to the same rule by every reader.
 */

/** Longest nickname, in code points - the profile form's `maxlength`, and PostgreSQL's unit. */
export const NICKNAME_MAX_LENGTH = 100;

/** The typed refusal of a nickname longer than {@link NICKNAME_MAX_LENGTH}. */
export const NICKNAME_TOO_LONG = 'nickname_too_long';

/** A normalized nickname (`null` = reset), or the refusal of one that is too long. */
export type NicknameNormalization =
  | { ok: true; value: string | null }
  | { ok: false; code: typeof NICKNAME_TOO_LONG };

/** Normalizes a raw nickname by the contract's rule - see the module comment. */
export function normalizeNickname(raw: string | null | undefined): NicknameNormalization {
  if (typeof raw !== 'string') return { ok: true, value: null };
  const value = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  if (!value) return { ok: true, value: null };
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, code: NICKNAME_TOO_LONG };
  return { ok: true, value };
}

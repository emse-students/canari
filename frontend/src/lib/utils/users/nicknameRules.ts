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
 *
 * The rule itself is `visibleText.ts`, kept byte-identical on both sides (a declared duplicate).
 */

export {
  NICKNAME_MAX_LENGTH,
  NICKNAME_TOO_LONG,
  normalizeNickname,
  type NicknameNormalization,
} from './visibleText';

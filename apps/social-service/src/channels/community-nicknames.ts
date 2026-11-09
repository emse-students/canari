/**
 * THE LIMITS OF A COMMUNITY NICKNAME, the server's half of `libs/contracts/conversation-nickname.json`
 * (the frontend's `nicknameRules.ts` is the other; each side's spec walks the contract's cases).
 *
 * Mirrors the profile's name fields (owner, 2026-10-14): NFKC, control and format characters dropped,
 * trimmed, at most {@link NICKNAME_MAX_LENGTH} code points - the unit `varchar(100)` counts. A value
 * empty once normalized is a RESET, never an empty nickname.
 *
 * The rule itself is `visible-text.ts`, kept byte-identical on both sides (a declared duplicate).
 */

export {
  NICKNAME_MAX_LENGTH,
  NICKNAME_TOO_LONG,
  normalizeNickname,
  type NicknameNormalization,
} from './visible-text';

/** 403 `code`: only a moderator names somebody in a community; a member may only clear their own. */
export const NICKNAME_REQUIRES_MODERATION = 'NICKNAME_REQUIRES_MODERATION';

/** 404 `code`: the person named is not a member of this community. */
export const NICKNAME_TARGET_NOT_MEMBER = 'NICKNAME_TARGET_NOT_MEMBER';

/**
 * Who may write `target`'s nickname in a community - THE ONLY definition (owner, 2026-10-14 and
 * 2026-10-18): a moderator (`roleGrantsModeration`, the grant the client is handed as
 * `viewerCanModerate`) names anybody; the person named may always CLEAR their own, moderator or not.
 */
export function mayWriteCommunityNickname(input: {
  actorIsTarget: boolean;
  isReset: boolean;
  actorCanModerate: boolean;
}): boolean {
  if (input.actorCanModerate) return true;
  return input.actorIsTarget && input.isReset;
}

/**
 * A REPORT NAMES ONE VERSION OF A NICKNAME: `<member row id>@<set-at ms>`. A report is filed once per
 * reporter per subject (`content_reports_reporter_content_uniq`), so naming the member row alone would
 * let one report of a first insult forbid reporting the next one set on the same person; and the
 * moderator reading it must see whether what was reported is still what is shown.
 */
export function nicknameReportSubject(memberRowId: string, setAtMs: number): string {
  return `${memberRowId}@${setAtMs}`;
}

/** The two halves of {@link nicknameReportSubject}, or null for a value that is not one. */
export function parseNicknameReportSubject(
  subject: string
): { memberRowId: string; setAtMs: number } | null {
  const match = /^([0-9a-f-]{36})@(\d{1,16})$/i.exec(subject);
  if (!match) return null;
  return { memberRowId: match[1].toLowerCase(), setAtMs: Number(match[2]) };
}

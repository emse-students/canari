import { canonicalUserOf } from '$lib/mls-client/leafIdentity';
import { applyNickname, boundedNicknameAt } from '$lib/utils/users/conversationNicknames.svelte';
import { normalizeNickname } from '$lib/utils/users/nicknameRules';

/** What one `nickname` frame did to the register. */
export type NicknameFrameOutcome = 'applied' | 'stale' | 'refused';

/** The one roster read every nickname source is held to: the users of an MLS group's tree. */
export interface NicknameRosterSource {
  getGroupMemberIdentities(groupId: string): Promise<string[]>;
}

/**
 * The users of `groupId`'s MLS tree, lowercased - or `null` when the tree cannot be read, which every
 * caller treats as "take nothing" (FAIL CLOSED): a nickname about somebody this device cannot place
 * in the conversation is not stored on a guess. Said at warn, with `where` naming the path.
 */
export async function nicknameMembersOf(
  source: NicknameRosterSource,
  groupId: string,
  where: string
): Promise<Set<string> | null> {
  try {
    const identities = await source.getGroupMemberIdentities(groupId);
    return new Set(
      identities.flatMap((identity) => {
        const user = canonicalUserOf(identity);
        return user ? [user.toLowerCase()] : [];
      })
    );
  } catch (e) {
    console.warn(
      `[NICKNAME] ${where}: the tree of ${groupId.slice(0, 8)}… is unreadable - nothing taken: ${String(e)}`
    );
    return null;
  }
}

/** How one frame is placed: its clocks, the roster it is held to, and where it is said. */
export interface NicknameFrameContext {
  /** The date of a frame that carries none: its log entry's server time (replay) or queue time (live). */
  fallbackAt: number;
  /** The server's time for the frame, bounding its `at` (`boundedNicknameAt`); absent = unbounded. */
  serverAt?: number;
  /** The group's current members ({@link nicknameMembersOf}); `null` = unreadable, refused. */
  members: ReadonlySet<string> | null;
  /**
   * Whether the SETTER must still be a member. True live: MLS just authenticated them in this tree, so
   * a miss is a defect worth the refusal. False on a replay: the log is the past, and a nickname
   * stays when its setter leaves (owner, 2026-10-18).
   */
  setterMustBeMember: boolean;
  log: (msg: string) => void;
}

/**
 * Applies one `nickname` MLS system frame - live or replayed from the shared log - to the register of
 * `scope` (the conversation's MLS group id). The ONE reader of the frame, so the live handler and the
 * archive replay cannot hold it to two rules.
 *
 * - **The setter is `senderNorm`**, the identity MLS authenticated for the frame - never a payload
 *   field, which any member could fill with somebody else's name.
 * - **Anybody may name anybody** (owner, 2026-10-14: a group has no ranks), so there is no
 *   permission to check; the frame is held to the nickname's own limits instead
 *   (`normalizeNickname`), and its TARGET must be a current member (review of #3177: a frame naming
 *   anybody else would only grow the stored register). A refusal ACCUSES: a build of this app never
 *   sends one, so reaching it means a peer that is not one.
 * - `at` is the sender's clock, BOUNDED by the server's time for the frame plus a small skew
 *   (`boundedNicknameAt`): an unbounded date would let one frame dated next year freeze a nickname.
 */
export function applyNicknameFrame(
  scope: string,
  data: { userId?: unknown; nickname?: unknown; at?: unknown } | null | undefined,
  senderNorm: string,
  ctx: NicknameFrameContext
): NicknameFrameOutcome {
  const { log, members } = ctx;
  const userId = typeof data?.userId === 'string' ? data.userId.trim().toLowerCase() : '';
  const normalized = normalizeNickname(typeof data?.nickname === 'string' ? data.nickname : null);
  const refusal = !userId
    ? 'it names nobody'
    : !normalized.ok
      ? normalized.code
      : members === null
        ? 'the roster is unreadable'
        : !members.has(userId)
          ? `${userId.slice(0, 8)} is no member`
          : ctx.setterMustBeMember && !members.has(senderNorm)
            ? 'its setter is no member'
            : null;
  if (refusal !== null || !normalized.ok || members === null) {
    log(
      `[NICKNAME] REFUSED a nickname frame from ${senderNorm.slice(0, 8)} in ${scope.slice(0, 8)}…: ${refusal}`
    );
    return 'refused';
  }
  const at = boundedNicknameAt(Number(data?.at) || ctx.fallbackAt, ctx.serverAt);
  const applied = applyNickname(
    scope,
    userId,
    { nickname: normalized.value, setBy: senderNorm, at },
    members
  );
  if (applied) {
    log(
      `[NICKNAME] ${userId.slice(0, 8)} ${normalized.value === null ? 'reset' : 'renamed'} by ${senderNorm.slice(0, 8)} in ${scope.slice(0, 8)}…`
    );
  }
  return applied ? 'applied' : 'stale';
}

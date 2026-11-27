/**
 * A MEMBER SENDS THEIR HISTORY TO A NEWCOMER - THE GRANT (owner, 2026-11-25, item 5).
 *
 * The decided default stands: a member added to a private group reads nothing from before their
 * arrival (docs/wiki/protocols/history-reconciliation.md, "A new member receives nothing from before
 * their arrival"). This module is the ONE visible exception to it: any member may press "Envoyer
 * l'historique des messages" under the notice that added someone, and send the newcomer what THEIR
 * OWN device holds, from a date they choose. Charter principle 1, *your messages are yours*
 * (docs/principes.md): the press hands over the OTHER members' messages too, so it is never silent -
 * the grant IS a notice every member reads.
 *
 * It rides the existing peer history exchange, never a second one:
 *
 * 1. **The grant** - a visible system frame (`historyGranted`), an MLS application message every
 *    member decrypts, naming the newcomer, the granting DEVICE and the start date. Every member
 *    draws it as the notice; the server sees ciphertext. The granter records it durably
 *    ({@link noteIssuedGrant}) BEFORE it leaves.
 * 2. **The newcomer's sealed ask** - each device of the newcomer that reads a grant naming its user
 *    describes its store to the GRANTER alone (`history_grant_ask`: the digest, a fresh request id
 *    and answer key, the grant id), and keeps the ask with the grant ({@link GrantedAsk}).
 * 3. **The granter's answer** - the ordinary diff answer (`answerHistoryDigest`), sealed to the ask
 *    and addressed to the asking device, filtered on the newcomer's OWN `withheld` windows with ONE
 *    change: the span before their arrival starts at the grant's date
 *    ({@link liftArrivalSpan}). Every gap - a Remove holding against a re-add - is withheld as before.
 * 4. **The receiver's lift** - the newcomer drops what lies inside its own windows from any bundle,
 *    EXCEPT that an answer to a grant ask, from the granting device and no other, is checked against
 *    the same lifted windows. Any other answer keeps the full drop.
 *
 * An older client ignores both frames (an unknown system event is acked silently): its newcomer
 * receives nothing, which is the decided default - but an older MEMBER would draw no notice, and the
 * notice every member reads is the condition the exception rests on (charter principle 1). So the
 * button is offered only while the server's `minClientVersion` is at or above
 * {@link HISTORY_GRANT_NOTICE_FIRST_VERSION}: every build still admitted then draws the notice
 * (lead, 2026-11-27).
 */
import { canonicalIdentity, canonicalUserId, canonicalUserOf } from '$lib/mls-client/leafIdentity';
import type { ExclusionWindow } from '$lib/mls-client/mlsDeliveryApi';
import type { Conversation } from '$lib/types';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { compareSemver } from '$lib/utils/appVersion';

/**
 * THE FIRST BUILD THAT DRAWS THE HISTORY-GRANT NOTICE (`historyGranted`) - `1.8.3-alpha.1`, the first
 * alpha that shipped the reader, NAMED AS A REAL VERSION: a pre-release orders below its stable, so a
 * floor of the bare `1.8.3` could never be served on the pre-release estate (it would lock out every
 * 1.8.3 alpha, dev's own web bundle included) and the button could never be read there; the floor DTO
 * accepts `x.y.z-alpha.N` for that. Production's `1.8.3` floor still draws it. A grant is offered only
 * while the server's `minClientVersion` is at or above it, so no member still admitted runs a build
 * that would receive the hand-over silently (charter principle 1; lead, 2026-11-27).
 */
export const HISTORY_GRANT_NOTICE_FIRST_VERSION = '1.8.3-alpha.1';

/**
 * Whether the served client floor (`minClientVersion`, `null` before the version check answered)
 * guarantees every admitted member draws the grant's notice. An unknown floor is not a floor.
 */
export function floorDrawsGrantNotice(minClientVersion: string | null | undefined): boolean {
  return (
    typeof minClientVersion === 'string' &&
    minClientVersion !== '' &&
    compareSemver(minClientVersion, HISTORY_GRANT_NOTICE_FIRST_VERSION) >= 0
  );
}

/** The visible event a grant is sent and drawn as. */
export const HISTORY_GRANT_EVENT = 'historyGranted' as const;

/** The newcomer's ask under a grant - a system event only the granting device answers. */
export const HISTORY_GRANT_ASK_EVENT = 'history_grant_ask' as const;

/**
 * One grant, as the frame carries it. `granter` is a DEVICE (`user:device`, canonical -
 * `canonicalIdentity`): the messages are that device's, and only it answers. `since` is a
 * server-clock instant in ms; `0` is "everything".
 */
export interface HistoryGrant {
  grantId: string;
  newcomer: string;
  granter: string;
  since: number;
}

/** Why a received grant frame is refused - typed, so each cause is logged by name. */
export type GrantRefusal = 'malformed' | 'granter-is-not-the-sender' | 'grant-to-self';

/** The shape a grant id must have - what `crypto.randomUUID` mints. */
const GRANT_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A fresh grant id. */
export function mintGrantId(): string {
  return crypto.randomUUID();
}

/** The payload of a grant frame. */
export function historyGrantPayload(grant: HistoryGrant): Record<string, unknown> {
  return {
    grantId: grant.grantId,
    newcomer: grant.newcomer,
    granter: grant.granter,
    since: grant.since,
  };
}

/**
 * Reads a grant frame's payload, checked against the MLS-verified sender: the granting device's
 * USER must be the sender, and when the delivery names the sending device it must be that device -
 * so no member can grant in another's name, nor name another device of their own as the one that
 * answers. A grant naming its own sender as the newcomer is refused: nobody grants to themselves.
 */
export function parseHistoryGrant(
  data: Record<string, unknown> | null | undefined,
  sender: string,
  senderDeviceId?: string
): { grant: HistoryGrant } | { refused: GrantRefusal } {
  const grantId = typeof data?.grantId === 'string' ? data.grantId : '';
  const newcomer = typeof data?.newcomer === 'string' ? canonicalUserId(data.newcomer) : '';
  const granter = typeof data?.granter === 'string' ? canonicalIdentity(data.granter) : null;
  const since = Number(data?.since);
  if (
    !GRANT_ID.test(grantId) ||
    !newcomer ||
    granter === null ||
    !Number.isFinite(since) ||
    since < 0
  ) {
    return { refused: 'malformed' };
  }
  const granterUser = canonicalUserOf(granter);
  if (granterUser !== canonicalUserId(sender)) return { refused: 'granter-is-not-the-sender' };
  if (senderDeviceId && granter !== canonicalIdentity(`${granterUser}:${senderDeviceId}`)) {
    return { refused: 'granter-is-not-the-sender' };
  }
  if (newcomer === granterUser) return { refused: 'grant-to-self' };
  return { grant: { grantId, newcomer, granter, since: Math.floor(since) } };
}

/**
 * The windows a GRANTED answer is filtered on: `windows` with the span before the reader's first
 * arrival (the one window that starts at 0, `withheldWindows` on the server) cut to start at `since`.
 * `since = 0` lifts it whole. Every other window - a gap while the reader was out of the group - is
 * kept as it is: a grant never hands over what a Remove withheld. A span with no end (`until: null`,
 * a person the server records no arrival for) is kept: nothing is granted to someone who never
 * arrived.
 */
export function liftArrivalSpan(
  windows: readonly ExclusionWindow[],
  since: number
): ExclusionWindow[] {
  const out: ExclusionWindow[] = [];
  for (const w of windows) {
    if (w.from !== 0 || w.until === null) {
      out.push(w);
      continue;
    }
    const until = Math.min(w.until, since);
    if (until > 0) out.push({ from: 0, until });
  }
  return out;
}

/** The start-date shortcuts of the picker. `everything` is `since = 0`. */
export type GrantPreset = '24h' | '7d' | '30d' | 'everything';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The `since` a shortcut stands for, read against `now`. */
export function grantSinceFor(preset: GrantPreset, now: number): number {
  switch (preset) {
    case '24h':
      return now - DAY_MS;
    case '7d':
      return now - 7 * DAY_MS;
    case '30d':
      return now - 30 * DAY_MS;
    case 'everything':
      return 0;
  }
}

/**
 * The `since` a picked calendar date stands for: its local midnight. `null` for a date that does not
 * parse or lies in the future - the picker refuses it rather than inventing one.
 */
export function grantSinceForDate(isoDate: string, now: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(at) && at <= now ? at : null;
}

/**
 * WHETHER THE BUTTON IS OFFERED under a notice that added `target` - the newcomer predicate.
 *
 * Only a `memberAdded` notice carries the button, and that notice is written for a PERSON's
 * addition only: a member's further device is added by itself and draws no notice, so a new device
 * of an existing member never shows it (it restores its own history). Beside that: a private group
 * conversation that is ready (never a community, a 1:1 or "Mes notes"), a target that is not this
 * account, and a target the roster still holds - a person removed since has nothing to receive.
 * And the served client floor must draw the notice ({@link floorDrawsGrantNotice}).
 */
export function canOfferHistoryTo(params: {
  conversation: Pick<Conversation, 'conversationType' | 'lifecycle'> | null | undefined;
  target: string;
  self: string;
  members: readonly string[];
  /** The server's `minClientVersion`, `null` before the version check answered. */
  minClientVersion: string | null | undefined;
}): boolean {
  const { conversation, target, self, members, minClientVersion } = params;
  if (!floorDrawsGrantNotice(minClientVersion)) return false;
  if (conversation?.conversationType !== 'group' || conversation.lifecycle !== 'active') {
    return false;
  }
  const who = canonicalUserId(target);
  if (!who || who === canonicalUserId(self)) return false;
  return members.some((m) => canonicalUserId(m) === who);
}

/**
 * How many grants one account keeps issued. A grant is answered when its newcomer's devices ask,
 * which they do on reading it; the oldest is pushed out by newer ones - state, never a clock.
 */
export const ISSUED_GRANTS_MAX = 64;

/** One grant this device issued, in the conversation it was issued in. */
type IssuedGrant = HistoryGrant & { group: string };

function readIssued(account: string): IssuedGrant[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.historyGrantsIssued(account.toLowerCase()));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (g): g is IssuedGrant =>
            typeof g === 'object' &&
            g !== null &&
            typeof (g as IssuedGrant).group === 'string' &&
            typeof (g as IssuedGrant).grantId === 'string' &&
            typeof (g as IssuedGrant).newcomer === 'string' &&
            typeof (g as IssuedGrant).granter === 'string' &&
            Number.isFinite((g as IssuedGrant).since)
        )
      : [];
  } catch (e) {
    console.error(
      `[HISTORY_GRANT] issued grants unreadable - read as none: ${String(e).slice(0, 120)}`
    );
    return [];
  }
}

/**
 * Records a grant this device is about to send, BEFORE it leaves: the newcomer's ask can come back
 * before the send resolves, and a reload in between must still answer it. `false` (said at error)
 * when the store refused it - the caller then sends no grant, since none could be answered.
 */
export function noteIssuedGrant(account: string, groupId: string, grant: HistoryGrant): boolean {
  const issued = readIssued(account).filter((g) => g.grantId !== grant.grantId);
  issued.push({ ...grant, group: groupId });
  try {
    localStorage.setItem(
      ACCOUNT_KEY.historyGrantsIssued(account.toLowerCase()),
      JSON.stringify(issued.slice(-ISSUED_GRANTS_MAX))
    );
    return true;
  } catch (e) {
    console.error(`[HISTORY_GRANT] issued grant not recorded: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/**
 * The grant `grantId` this device issued in `groupId` to `asker`'s user, or `null` - then the ask
 * is answered nothing: a grant ask is believed only against a grant this very device made, to that
 * very person.
 */
export function issuedGrantFor(
  account: string,
  groupId: string,
  grantId: string,
  askerUser: string
): HistoryGrant | null {
  const found = readIssued(account).find(
    (g) =>
      g.group === groupId &&
      g.grantId === grantId &&
      canonicalUserId(g.newcomer) === canonicalUserId(askerUser)
  );
  if (!found) return null;
  return {
    grantId: found.grantId,
    newcomer: found.newcomer,
    granter: found.granter,
    since: found.since,
  };
}

/**
 * The grant an ask is made under, kept with the ask (`historyAddressing.ts`): only `granter` may
 * answer it, and its answer is checked against windows lifted from `since`.
 */
export interface GrantedAsk {
  grantId: string;
  /** The granting device, canonical (`user:device`, `canonicalIdentity`). */
  granter: string;
  since: number;
}

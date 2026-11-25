import { canonicalIdentity } from './leafIdentity';
import type { DeviceEvent, MembershipEvidence } from './deviceTrust';

/**
 * A NEW PERSON WHO ENTERED A CONVERSATION BY THEIR OWN COMMIT ({@link entersUninvited}), as the
 * server is told it.
 *
 * A MEASUREMENT, the shape `verifiedSender.ts` already has. An entry no member made is either a
 * device whose user lost every leaf rejoining by itself - a path nobody has counted - or one nobody
 * wanted, and the two are told apart by reading production, not by guessing. So the client writes the
 * entry in the conversation and reports it (`docs/wiki/protocols/mls-protocol.md`).
 *
 * A client's console is collected nowhere, so the server's `[UNINVITED_ENTRY]` line is the whole of
 * the measurement.
 *
 * @see entersUninvited in `deviceTrust.ts`, the predicate.
 */
/**
 * What THIS device knows about the entrant, which separates a legitimate self-rejoin from an entry
 * nobody wanted (`noteUninvitedEntries` in `deviceNotices.svelte.ts` decides it):
 *
 * - `returning`: a MEMBER coming back - a member who lost every leaf and rejoined, or added their
 *   own new device by external join, which the external join exists for. PROVEN ON THIS DEVICE
 *   (owner, 2026-11-14): it saw the same USER hold a leaf of a tree of this group it accepted, at an
 *   epoch before the entry (`IMlsService.membershipEvidence`). Never the server's word.
 * - `direct-peer`: the other person of a 1:1 conversation - the conversation IS the two of them.
 * - `new-person`: NOT PROVEN a member by this device - written in the conversation, since a member
 *   must be told about it. Reported with `watchedFromEpoch`, so a device that was not there yet when
 *   a member left is counted apart from one that watched the whole time.
 * - `unvouched-device`: a device of a user ALREADY in the tree, seen for the first time, that
 *   admitted itself (`entersAsUnvouchedDevice`). No member added it - a further device of a member is
 *   a member's Add after a member's tap, and an honest device never joins itself on a seat no commit
 *   admitted - so it is written in the conversation too, and accuses.
 */
export type UninvitedEntryKind = 'new-person' | 'returning' | 'direct-peer' | 'unvouched-device';

/**
 * The ENTRANT'S OWN WORD for an entry no member made (slice 1 of the admission fix-forward,
 * `docs/wiki/protocols/admission-fix-forward.md`): what the device that let itself in - its tree
 * holding no leaf of its account (`no-leaf-of-user`) - knew when it decided to commit. Classified at
 * the throw, from facts only that device holds, so the count can say WHICH legitimate path produced
 * each entry its members report, and the gate that re-arms the refusal can be read off it.
 *
 * The group classes are the seat reading that opened the door (`requestReAdd`), named as it is -
 * a fact, not a guess at the path; the wiki page maps each to the producers it can be.
 *
 * - `entrant-direct-peer`: a 1:1 conversation - the peer whose KeyPackage was skipped at creation,
 *   or whose only device went. The emission side never asks there: the 1:1 IS that peer.
 * - `entrant-unhonoured-seat`: a group conversation, this device's row `pending` with nobody owing
 *   it a Welcome - a seat whose KeyPackage was skipped by the Add that wrote it, a seat written
 *   before migration 038, a device row demoted out of `active`.
 * - `entrant-not-pending`: a group conversation, this device's row `active` - a device that was IN
 *   the group and lost its only leaf while its row stood (the evicted-only-leaf path).
 * - `entrant-no-device-row`: a group conversation, the ACCOUNT seated and this device holding no row
 *   - a new device of a user whose every leaf went (the revoked-and-swept path).
 */
export type EntrantEntryKind =
  | 'entrant-direct-peer'
  | 'entrant-unhonoured-seat'
  | 'entrant-not-pending'
  | 'entrant-no-device-row';

export interface UninvitedEntryReport {
  /**
   * Sent as the server's `kind=` field, so the count separates the classes. A member's
   * {@link UninvitedEntryKind}, or the entrant's own {@link EntrantEntryKind} - whose `entrant` the
   * server takes from the authenticated caller, never from the body.
   */
  kind: UninvitedEntryKind | EntrantEntryKind;
  groupId: string;
  /** The admitted leaf, `userId:deviceId` - the user half canonical. */
  entrant: string;
  /** The epoch the entering commit created. */
  epoch: number;
  /** Which key entered (`DeviceEvent.keyFingerprint`); absent from the entrant's own report. */
  keyFingerprint?: string;
  /**
   * For `returning` and `new-person`: the first epoch this device's record of the group covers
   * (`MembershipEvidence.watchedFromEpoch`), `null` when it holds none. The evidence separating a
   * device that was not there yet from one that watched and never saw the entrant; absent for the
   * kinds the device decides without it.
   */
  watchedFromEpoch?: number | null;
}

/** Sends a report somewhere a human reads it. Wired once by the MLS service. */
export type UninvitedEntryReporter = (report: UninvitedEntryReport) => Promise<unknown>;

let reporter: UninvitedEntryReporter | null = null;

/** Each entry is reported ONCE per app session: the first answers whether it happens, and to whom. */
const reported = new Set<string>();

/** Wires where an entry is reported. `null` unwires it (tests, logout). */
export function setUninvitedEntryReporter(next: UninvitedEntryReporter | null): void {
  reporter = next;
}

/** Forgets which entries were reported, so a test starts from nothing. */
export function resetReportedUninvitedEntries(): void {
  reported.clear();
}

/**
 * Logs an entry no member made and reports it once, with its {@link UninvitedEntryKind}: a
 * `new-person` at a level that accuses, a legitimate rejoin as what it is.
 *
 * Called only for a CONVERSATION: in a community or salon key group an external commit is how every
 * member enters, and the caller does not ask.
 */
export function reportUninvitedEntry(
  event: DeviceEvent,
  kind: UninvitedEntryKind,
  evidence?: MembershipEvidence
): void {
  const report: UninvitedEntryReport = {
    kind,
    groupId: event.groupId,
    entrant: canonicalIdentity(event.identity) ?? event.identity,
    epoch: event.epoch,
    keyFingerprint: event.keyFingerprint,
    ...(evidence ? { watchedFromEpoch: evidence.watchedFromEpoch } : {}),
  };
  if (kind === 'new-person') {
    console.error(
      `[MLS] UNINVITED ENTRY group=${event.groupId.slice(0, 8)} entrant=${report.entrant} epoch=${event.epoch} watched_from=${evidence?.watchedFromEpoch ?? 'none'} - a user absent from the tree admitted themselves, and this device never saw them a member here before`
    );
  } else if (kind === 'unvouched-device') {
    console.error(
      `[MLS] UNINVITED ENTRY group=${event.groupId.slice(0, 8)} entrant=${report.entrant} epoch=${event.epoch} key=${event.keyFingerprint} - a known device of a member admitted itself under a key other than the one known for it; no member added it`
    );
  } else {
    console.log(
      `[MLS] self-rejoin group=${event.groupId.slice(0, 8)} entrant=${report.entrant} epoch=${event.epoch} kind=${kind} - not written in the conversation, reported for the count`
    );
  }
  const key = `${event.groupId}|${report.entrant}|${event.keyFingerprint}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (!reporter) {
    console.warn('[MLS] UNINVITED ENTRY not reported: no reporter is wired');
    return;
  }
  void reporter(report).catch((e: unknown) => {
    console.warn(`[MLS] UNINVITED ENTRY report failed: ${String(e)}`);
  });
}

/**
 * The entrant's class of its own entry, from the two facts it decided the join on. PURE.
 *
 * @param isGroup the conversation row's `isGroup` (a 1:1 is `false`), read, never defaulted.
 * @param seat the reading of this device's seat that opened the self-service door: only these
 *   three ever reach an external join (`requestReAdd`).
 */
export function classifyOwnUninvitedEntry(
  isGroup: boolean,
  seat: 'unhonoured-seat' | 'not-pending' | 'no-device-row'
): EntrantEntryKind {
  if (!isGroup) return 'entrant-direct-peer';
  return `entrant-${seat}`;
}

/**
 * Reports THIS DEVICE'S OWN entry no member made, once per app session: its external commit into a
 * conversation was ACCEPTED on a tree holding no leaf of its account
 * (`ExternalJoinOutcome.enteredWithNoLeafAtEpoch`). Same table, same key as its members' reports -
 * `(group, entrant, epoch)` - so each `[UNINVITED_ENTRY] kind=new-person` row pairs with the
 * entrant's own `entrant-*` row for the same entry, and an unpaired one is an entry no client at
 * this build made (an older build, a lost report, or a client that is not ours).
 *
 * Logged as what it is - a legitimate path today, counted - never at a level that accuses: the
 * members' reports accuse, and this one explains.
 */
export function reportOwnUninvitedEntry(
  groupId: string,
  self: string,
  epoch: number,
  kind: EntrantEntryKind
): void {
  console.log(
    `[MLS] own entry with no leaf of this account group=${groupId.slice(0, 8)} epoch=${epoch} kind=${kind} - reported for the admission fix-forward's count`
  );
  const key = `${groupId}|${self}|${epoch}|own`;
  if (reported.has(key)) return;
  reported.add(key);
  if (!reporter) {
    console.warn('[MLS] own uninvited entry not reported: no reporter is wired');
    return;
  }
  void reporter({ kind, groupId, entrant: self, epoch }).catch((e: unknown) => {
    console.warn(`[MLS] own uninvited entry report failed: ${String(e)}`);
  });
}

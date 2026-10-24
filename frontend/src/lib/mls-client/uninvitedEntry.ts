import { canonicalIdentity } from './leafIdentity';
import type { DeviceEvent } from './deviceTrust';

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
 * - `returning`: this device saw the same USER leave the tree at an earlier epoch
 *   (`IMlsService.removalEpochs`) - a member who lost every leaf and rejoined, which the external
 *   join exists for.
 * - `direct-peer`: the other person of a 1:1 conversation - the conversation IS the two of them.
 * - `new-person`: neither - the only kind written in the conversation, since it is the only one a
 *   member must be told about. A device that never saw a departure reads a returning member as this.
 */
export type UninvitedEntryKind = 'new-person' | 'returning' | 'direct-peer';

export interface UninvitedEntryReport {
  /** Sent as the server's `kind=` field, so the count separates the three. */
  kind: UninvitedEntryKind;
  groupId: string;
  /** The admitted leaf, `userId:deviceId` - the user half canonical. */
  entrant: string;
  /** The epoch the entering commit created. */
  epoch: number;
  /** Which key entered (`DeviceEvent.keyFingerprint`). */
  keyFingerprint: string;
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
export function reportUninvitedEntry(event: DeviceEvent, kind: UninvitedEntryKind): void {
  const report: UninvitedEntryReport = {
    kind,
    groupId: event.groupId,
    entrant: canonicalIdentity(event.identity) ?? event.identity,
    epoch: event.epoch,
    keyFingerprint: event.keyFingerprint,
  };
  if (kind === 'new-person') {
    console.error(
      `[MLS] UNINVITED ENTRY group=${event.groupId.slice(0, 8)} entrant=${report.entrant} epoch=${event.epoch} - a user absent from the tree admitted themselves; no member added them`
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

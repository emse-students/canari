import { deviceIdOfLeaf, userIdOfLeaf } from './leafIdentity';

/**
 * The sender the delivery server's ENVELOPE names, checked against the one OpenMLS VERIFIED.
 *
 * Until 2026-09-28 the verified sender was dropped where the plaintext was returned
 * (`mls-core/src/messaging.rs`), so every consumer - a DM's author, a Graine seed's minter, a
 * system event's origin - named whoever the server's envelope claimed. The envelope is a claim; the
 * credential is a proof (channel-encryption section 21, WP-G2-1).
 *
 * **THIS IS THE MEASUREMENT HALF, AND IT REFUSES NOTHING** (decided by the user, 2026-09-28). A
 * legitimate disagreement nobody foresaw - an id's case, a system frame, a path that names the
 * sender differently - would lose messages if it were refused blind. So one release logs every
 * disagreement at ERROR and REPORTS it to the server, where `[SENDER_MISMATCH]` is readable, and the
 * refusal follows once production has been read. The console alone would be no measurement:
 * nothing in this product collects a client's console.
 */

/** Which decrypt path the frame came through - each names its envelope from a different field. */
export type SenderCheckPath = 'live' | 'distribution' | 'welcome-replay' | 'history';

/** The sender a frame's delivery envelope names. */
export interface EnvelopeSender {
  userId: string;
  /** Self-asserted by the sending client in its request body; absent on paths that do not carry it. */
  deviceId?: string;
  path: SenderCheckPath;
}

/**
 * What disagreed: the user (the half every consumer attributes by), only the device, or nothing
 * could be compared because the credential was unreadable.
 */
export type SenderMismatchKind = 'user' | 'device' | 'unverifiable';

/** One disagreement, as the server is told it. */
export interface SenderMismatchReport {
  groupId: string;
  path: SenderCheckPath;
  kind: SenderMismatchKind;
  envelopeUserId: string;
  envelopeDeviceId: string | null;
  verifiedIdentity: string | null;
}

/** Sends a report somewhere a human reads it. Wired once by the MLS service. */
export type SenderMismatchReporter = (report: SenderMismatchReport) => Promise<unknown>;

let reporter: SenderMismatchReporter | null = null;

/**
 * Each distinct disagreement is reported ONCE per app session. A misbehaving sender repeats the
 * same one on every frame, and the question the report answers - does this happen, on which path,
 * for whom - is answered by the first.
 */
const reported = new Set<string>();

/** Wires where a disagreement is reported. `null` unwires it (tests, logout). */
export function setSenderMismatchReporter(next: SenderMismatchReporter | null): void {
  reporter = next;
}

/** Forgets which disagreements were reported, so a test starts from nothing. */
export function resetReportedSenderMismatches(): void {
  reported.clear();
}

/**
 * Compares the envelope's sender with the verified one, and logs and reports a disagreement.
 *
 * `verified` is `undefined` when the decrypt path carries no verified sender at all (a stub, or a
 * service that has not been given one) - nothing to compare, and not a disagreement. `null` is the
 * credential being UNREADABLE, which is: a frame whose sender cannot be checked.
 *
 * @returns the kind of disagreement, or null when the two agree - for the log and the tests; this
 *   half decides nothing with it.
 */
export function checkVerifiedSender(
  groupId: string,
  envelope: EnvelopeSender | undefined,
  verified: string | null | undefined
): SenderMismatchKind | null {
  if (!envelope || verified === undefined) return null;
  const kind = classify(envelope, verified);
  if (!kind) return null;

  const report: SenderMismatchReport = {
    groupId,
    path: envelope.path,
    kind,
    envelopeUserId: envelope.userId.toLowerCase(),
    envelopeDeviceId: envelope.deviceId ?? null,
    verifiedIdentity: verified,
  };
  console.error(
    `[MLS] SENDER MISMATCH (${kind}) group=${groupId.slice(0, 8)} path=${envelope.path} envelope=${report.envelopeUserId}:${report.envelopeDeviceId ?? '?'} verified=${verified ?? 'unreadable'} - measured, not refused`
  );

  const key = `${groupId}|${envelope.path}|${kind}|${report.envelopeUserId}|${report.envelopeDeviceId ?? ''}|${verified ?? ''}`;
  if (reported.has(key)) return kind;
  reported.add(key);
  if (!reporter) {
    console.warn('[MLS] SENDER MISMATCH not reported: no reporter is wired');
    return kind;
  }
  void reporter(report).catch((e) => {
    console.warn(`[MLS] SENDER MISMATCH report failed: ${String(e)}`);
  });
  return kind;
}

function classify(envelope: EnvelopeSender, verified: string | null): SenderMismatchKind | null {
  if (verified === null) return 'unverifiable';
  if (userIdOfLeaf(verified) !== envelope.userId.toLowerCase()) return 'user';
  if (envelope.deviceId && envelope.deviceId !== deviceIdOfLeaf(verified)) return 'device';
  return null;
}

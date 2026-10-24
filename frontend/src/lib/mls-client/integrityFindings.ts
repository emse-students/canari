/**
 * The two things a private conversation must never show, recorded where they are seen and reported
 * where a human reads them.
 *
 * - `fork`: a frame carried a signed epoch fingerprint that is not ours at the same epoch number -
 *   two trees exist for one conversation (`mls-core/src/fork_check.rs`). mls-core records it on the
 *   decrypt path; this side takes it after a same-epoch refusal.
 * - `forged-history`: a history bundle relayed a message, an edit, a deletion or a reaction whose
 *   author signature does not verify (`$lib/crypto/messageAuthorship`). The entry is refused.
 *
 * The UI comes later. Today each finding is a line (ERROR when proven, warn when not), a bounded in-memory record a diagnostic
 * screen can read, and ONE report to the server per distinct finding per session
 * (`POST mls/integrity-finding`, `[INTEGRITY]`), since a client console is collected nowhere.
 *
 * Protocol: `docs/wiki/protocols/history-reconciliation.md` and `docs/wiki/protocols/mls-protocol.md`.
 */

/** What was seen. */
export type IntegrityFindingKind = 'fork' | 'forged-history';

/** One finding, as recorded and as the server is told it. */
export interface IntegrityFinding {
  kind: IntegrityFindingKind;
  groupId: string;
  /** The epoch a fork was seen at; absent for forged history. */
  epoch?: number;
  /** `userId:deviceId` whose claim differs, or the relaying user of a forged entry. */
  peer: string;
  /** A short fixed code (`fork`, `unproven`, `contradiction`, `message`, `edit`, ...), never prose. */
  detail: string;
  /**
   * Whether the finding is ESTABLISHED (`true`: a proven fork, a contradiction, a forged signature)
   * or only seen (`false`: a fork mls-core could not attribute). It picks the level, here as in
   * mls-core (ERROR / warn) and on the server - a typed field, so no reader decides it from `detail`.
   */
  proven: boolean;
}

/**
 * One finding as mls-core hands it over (`take_fork_findings`): `fork` is proven by the sender's
 * key in our tree, `unproven` could not be, `contradiction` is a frame that decrypted at our epoch
 * and claimed another fingerprint.
 */
export interface ForkFinding {
  kind: 'fork' | 'unproven' | 'contradiction';
  groupId: string;
  epoch: number;
  peer: string;
  detail: string;
}

/** Where fork findings are taken from - the MLS service, narrowed for tests. */
export interface ForkFindingSource {
  takeForkFindings(): Promise<ForkFinding[]>;
}

/**
 * Takes what mls-core recorded and notes each as a `fork` finding (its kind as the detail). Called
 * after a same-epoch refusal, the one event a fork shows up as. A failure to take is logged: the
 * Rust ERROR line already recorded the fork, only the report is lost.
 */
export async function drainForkFindings(
  mls: ForkFindingSource,
  log: (msg: string) => void
): Promise<number> {
  let findings: ForkFinding[];
  try {
    findings = await mls.takeForkFindings();
  } catch (e) {
    log(`[FORK] could not take the fork findings: ${String(e)}`);
    return 0;
  }
  for (const f of findings) {
    noteIntegrityFinding({
      kind: 'fork',
      groupId: f.groupId,
      epoch: f.epoch,
      peer: f.peer,
      detail: f.kind,
      proven: f.kind !== 'unproven',
    });
  }
  return findings.length;
}

/** Sends a finding somewhere a human reads it. Wired once by the MLS service. */
export type IntegrityFindingReporter = (finding: IntegrityFinding) => Promise<unknown>;

/** How many findings the in-memory record keeps - the newest win. */
const MAX_RECORDED = 100;

let reporter: IntegrityFindingReporter | null = null;
const recorded: Array<IntegrityFinding & { at: number }> = [];
const reported = new Set<string>();

/** Wires where a finding is reported. `null` unwires it (tests, logout). */
export function setIntegrityFindingReporter(next: IntegrityFindingReporter | null): void {
  reporter = next;
}

/** The findings recorded this session, oldest first. */
export function recordedIntegrityFindings(): ReadonlyArray<IntegrityFinding & { at: number }> {
  return recorded;
}

/** Forgets every finding and every report, so a test starts from nothing. */
export function resetIntegrityFindings(): void {
  recorded.length = 0;
  reported.clear();
}

/**
 * Records a finding, logs it - at ERROR when `proven`, at warn when not, the levels mls-core uses
 * (`fork_check.rs`) - and reports it once per session. A report that fails is logged and dropped:
 * the record and the line stay, and the next session reports it again.
 */
export function noteIntegrityFinding(finding: IntegrityFinding): void {
  recorded.push({ ...finding, at: Date.now() });
  if (recorded.length > MAX_RECORDED) recorded.shift();
  const line = `[INTEGRITY] ${finding.kind} in ${finding.groupId.slice(0, 8)}...${finding.epoch !== undefined ? ` at epoch ${finding.epoch}` : ''} - ${finding.peer} (${finding.detail})`;
  if (finding.proven) console.error(line);
  else console.warn(line);
  const key = `${finding.kind}|${finding.groupId}|${finding.epoch ?? ''}|${finding.peer}|${finding.detail}`;
  if (!reporter || reported.has(key)) return;
  reported.add(key);
  reporter(finding).catch((e: unknown) => {
    // The line above already says what happened; this says the server will not hear of it.
    console.warn(`[INTEGRITY] report of ${finding.kind} not delivered: ${String(e)}`);
  });
}

/**
 * THE SERVER'S SIGNATURE ON A REPORTED LIVE CHAT LINE (WP-L8b; owner, 2026-10-20: "the reporter
 * hands the plaintext line, the server signs and records it").
 *
 * HMAC-SHA256 under `LIVE_REPORT_SIGNING_KEY` (32+ characters, a secret of each estate, never in the
 * database), base64url. THREE signatures per line, so an ERASURE costs exactly the proof of the one
 * id it rewrote and nothing else:
 *
 *   signature          = HMAC(["canari-live-chat-report-v1", reportId, liveId, messageId, seq,
 *                              clientId, sealedSha256, messageCreatedAt, keptAt (ISO), text])
 *   authorSignature    = HMAC(["canari-live-chat-report-author-v1", reportId, authorId])
 *   reporterSignature  = HMAC(["canari-live-chat-report-reporter-v1", reportId, reporterId])
 *
 * Every field of the first never changes once kept - `keptAt` included, since the 90-day bound is
 * counted from it. An account signature that fails reads `erased` ONLY when its own id is the
 * erasure's tombstone; any other failure reads `altered` - so an id rewritten to ANOTHER account is
 * never hidden behind the other id's erasure (review of #2172). A row altered in the database reads
 * `altered`. The key's id is an HMAC of a fixed label under the key (16 hex characters), which names
 * the key without being a hash of it; ROTATING the key leaves the lines it signed reading
 * `key-rotated` - the text is still shown, their proof is gone. Rotate when no `live_chat` report
 * is pending, or accept that. Nothing here is a fallback: with no key, a line is not kept at all,
 * and the report is refused 503 `LIVE_REPORT_SIGNING_UNAVAILABLE` (`signingKey` returns null,
 * logged at error by the caller); a line READ while no key is configured is `unverifiable`.
 *
 * WHAT THESE VERDICTS CANNOT TELL APART, stated (delta review of #2172): `key-rotated` only means
 * "the stored keyId is not the current key's" - a row whose keyId was itself rewritten reads the
 * same, and a list of retired ids would not close it (a writer can copy a genuinely retired id).
 * So `key-rotated` and `unverifiable` are PROOF ABSENT, to be weighed as `altered` is, never as a
 * lesser doubt. And an id rewritten TO the tombstone reads `erased`, exactly as a real erasure does.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** The shortest key accepted - `render-env.sh` refuses a shorter one before a deploy. */
export const LIVE_REPORT_SIGNING_KEY_MIN_LENGTH = 32;

/** The fields of a kept line the content signature covers. */
export interface ReportedLineContent {
  reportId: string;
  liveId: string;
  messageId: string;
  seq: number;
  clientId: string;
  sealedSha256: string;
  messageCreatedAt: Date;
  /** When the line was kept: the start of the 90-day bound, so it is signed with the rest. */
  keptAt: Date;
  text: string;
}

/** The account ids the two account signatures cover, one each. */
export interface ReportedLineAccounts {
  reportId: string;
  authorId: string;
  reporterId: string;
}

/**
 * Why a signature cannot vouch for a line: signed under another key id, or no key configured on
 * this estate to check it with. Both are PROOF ABSENT, weighed as `altered` is.
 */
export type ReportedLineUnproven = 'key-rotated' | 'unverifiable';

/** One account signature's verdict. */
export type ReportedAccountIntegrity = 'verified' | 'altered' | 'erased' | ReportedLineUnproven;

/** What a moderator is told about a kept line's integrity. */
export interface ReportedLineIntegrity {
  content: 'verified' | 'altered' | ReportedLineUnproven;
  author: ReportedAccountIntegrity;
  reporter: ReportedAccountIntegrity;
}

/** The stored signatures of a kept line. */
export interface ReportedLineSignatures {
  keyId: string;
  signature: string;
  authorSignature: string;
  reporterSignature: string;
}

/** The key and its id, or null when `LIVE_REPORT_SIGNING_KEY` is unset or too short. */
export function signingKey(): { key: Buffer; keyId: string } | null {
  const raw = process.env.LIVE_REPORT_SIGNING_KEY ?? '';
  if (raw.length < LIVE_REPORT_SIGNING_KEY_MIN_LENGTH) return null;
  const key = Buffer.from(raw, 'utf8');
  const keyId = createHmac('sha256', key)
    .update('canari-live-report-key-id-v1')
    .digest('hex')
    .slice(0, 16);
  return { key, keyId };
}

function mac(key: Buffer, fields: readonly (string | number)[]): string {
  return createHmac('sha256', key).update(JSON.stringify(fields)).digest('base64url');
}

function contentFields(c: ReportedLineContent): (string | number)[] {
  return [
    'canari-live-chat-report-v1',
    c.reportId,
    c.liveId,
    c.messageId,
    c.seq,
    c.clientId,
    c.sealedSha256,
    c.messageCreatedAt.toISOString(),
    c.keptAt.toISOString(),
    c.text,
  ];
}

function authorFields(a: ReportedLineAccounts): string[] {
  return ['canari-live-chat-report-author-v1', a.reportId, a.authorId];
}

function reporterFields(a: ReportedLineAccounts): string[] {
  return ['canari-live-chat-report-reporter-v1', a.reportId, a.reporterId];
}

/** Signs a line about to be kept. */
export function signReportedLine(
  key: { key: Buffer; keyId: string },
  content: ReportedLineContent,
  accounts: ReportedLineAccounts
): ReportedLineSignatures {
  return {
    keyId: key.keyId,
    signature: mac(key.key, contentFields(content)),
    authorSignature: mac(key.key, authorFields(accounts)),
    reporterSignature: mac(key.key, reporterFields(accounts)),
  };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** One account signature: `erased` only when the failing id IS the tombstone, else `altered`. */
function accountVerdict(
  ok: boolean,
  id: string,
  erasedAccount: string
): Exclude<ReportedAccountIntegrity, ReportedLineUnproven> {
  if (ok) return 'verified';
  return id === erasedAccount ? 'erased' : 'altered';
}

/**
 * Checks a kept line against its signatures. `erasedAccount` is the tombstone an erasure writes:
 * an account id equal to it whose own signature fails reads `erased`, never `altered`; the other
 * account must still verify on its own. No key (`key` null): every verdict is `unverifiable` - the
 * caller logs that at error, since the estate is then misconfigured.
 */
export function verifyReportedLine(
  key: { key: Buffer; keyId: string } | null,
  stored: ReportedLineSignatures,
  content: ReportedLineContent,
  accounts: ReportedLineAccounts,
  erasedAccount: string
): ReportedLineIntegrity {
  if (!key) {
    return { content: 'unverifiable', author: 'unverifiable', reporter: 'unverifiable' };
  }
  if (key.keyId !== stored.keyId) {
    return { content: 'key-rotated', author: 'key-rotated', reporter: 'key-rotated' };
  }
  return {
    content: same(mac(key.key, contentFields(content)), stored.signature) ? 'verified' : 'altered',
    author: accountVerdict(
      same(mac(key.key, authorFields(accounts)), stored.authorSignature),
      accounts.authorId,
      erasedAccount
    ),
    reporter: accountVerdict(
      same(mac(key.key, reporterFields(accounts)), stored.reporterSignature),
      accounts.reporterId,
      erasedAccount
    ),
  };
}

/**
 * THE SERVER'S SIGNATURE ON A REPORTED LIVE CHAT LINE (WP-L8b; owner, 2026-10-20: "the reporter
 * hands the plaintext line, the server signs and records it").
 *
 * HMAC-SHA256 under `LIVE_REPORT_SIGNING_KEY` (32+ characters, a secret of each estate, never in the
 * database), base64url. Two signatures per line, so an ERASURE does not cost the content its proof:
 *
 *   signature          = HMAC(["canari-live-chat-report-v1", reportId, liveId, messageId, seq,
 *                              clientId, sealedSha256, messageCreatedAt (ISO), text])
 *   accountsSignature  = HMAC(["canari-live-chat-report-accounts-v1", reportId, authorId, reporterId])
 *
 * Every field of the first never changes once kept; the second covers the two account ids, which an
 * erasure anonymises - it then reads `erased`, while the content still verifies. A row altered in the
 * database (the text, the author) reads `altered`. The key's id is the first 16 hex characters of a
 * SHA-256 of it, so ROTATING the key (set a new value) leaves the lines it signed reading
 * `key-rotated` - the text is still shown; their proof is gone. Rotate when no `live_chat` report is
 * pending, or accept that. Nothing here is a fallback: with no key, a line is not kept at all, and
 * the report is refused 503 `LIVE_REPORT_SIGNING_UNAVAILABLE` (`signingKey` returns null, logged
 * at error by the caller).
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

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
  text: string;
}

/** The account ids the accounts signature covers. */
export interface ReportedLineAccounts {
  reportId: string;
  authorId: string;
  reporterId: string;
}

/** What a moderator is told about a kept line's integrity. */
export interface ReportedLineIntegrity {
  content: 'verified' | 'altered' | 'key-rotated';
  accounts: 'verified' | 'altered' | 'erased' | 'key-rotated';
}

/** The key and its id, or null when `LIVE_REPORT_SIGNING_KEY` is unset or too short. */
export function signingKey(): { key: Buffer; keyId: string } | null {
  const raw = process.env.LIVE_REPORT_SIGNING_KEY ?? '';
  if (raw.length < LIVE_REPORT_SIGNING_KEY_MIN_LENGTH) return null;
  const key = Buffer.from(raw, 'utf8');
  const keyId = createHash('sha256')
    .update('canari-live-report-key-id\0')
    .update(key)
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
    c.text,
  ];
}

function accountFields(a: ReportedLineAccounts): string[] {
  return ['canari-live-chat-report-accounts-v1', a.reportId, a.authorId, a.reporterId];
}

/** Signs a line about to be kept. */
export function signReportedLine(
  key: { key: Buffer; keyId: string },
  content: ReportedLineContent,
  accounts: ReportedLineAccounts
): { keyId: string; signature: string; accountsSignature: string } {
  return {
    keyId: key.keyId,
    signature: mac(key.key, contentFields(content)),
    accountsSignature: mac(key.key, accountFields(accounts)),
  };
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Checks a kept line against its signatures. `erasedAccount` is the tombstone an erasure writes:
 * an account id equal to it reads `erased`, never `altered`.
 */
export function verifyReportedLine(
  key: { key: Buffer; keyId: string } | null,
  stored: { keyId: string; signature: string; accountsSignature: string },
  content: ReportedLineContent,
  accounts: ReportedLineAccounts,
  erasedAccount: string
): ReportedLineIntegrity {
  if (!key || key.keyId !== stored.keyId) {
    return { content: 'key-rotated', accounts: 'key-rotated' };
  }
  const contentOk = same(mac(key.key, contentFields(content)), stored.signature);
  const erased = accounts.authorId === erasedAccount || accounts.reporterId === erasedAccount;
  const accountsOk = same(mac(key.key, accountFields(accounts)), stored.accountsSignature);
  return {
    content: contentOk ? 'verified' : 'altered',
    accounts: accountsOk ? 'verified' : erased ? 'erased' : 'altered',
  };
}

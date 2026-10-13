/**
 * The privacy stage every line passes before it can enter the in-app log ({@link ./appLog}).
 *
 * WHY IT EXISTS. The in-app log is the one log that LEAVES the device: a member exports it and
 * hands it to us. Console lines were written for a developer at a terminal, and some of them name
 * things a member never agreed to send - a file name, a channel name, a query string carrying an
 * OIDC code. The console keeps printing them unchanged; what is written to the exportable log is
 * this function's output, never the raw line.
 *
 * IT IS A SCRUBBER WITH AN ALLOWLIST AT ITS CORE, AND THE ALLOWLIST IS THE QUOTED VALUE. A
 * blocklist of secrets cannot be complete, so the stages that carry the weight keep only what has
 * a known-harmless SHAPE: a quoted value survives only if it looks like an identifier, an enum or a
 * number, and a word survives only if it is ASCII. Everything else is replaced by a marker that
 * says what was there (`[email]`, `[jwt]`, `"[23 chars]"`) so the reader knows a value existed.
 *
 * WHAT IT CANNOT CATCH, said here so nobody believes otherwise: an UNQUOTED single ASCII word that
 * happens to be a name (`Joined channel #bureau`). No pattern separates `bureau` from `ready`. The
 * call sites that interpolated names unquoted were changed to log an id or a size instead
 * (2026-10-13), and a new one is a review finding, not something this function will save.
 *
 * Pure, synchronous, no imports beyond the id truncation: it runs on every captured line.
 */
import { truncateLogIds } from './logTruncate';

/** The longest line the log keeps. A line is a sentence; anything longer is a dump. */
export const MAX_LOG_LINE_CHARS = 400;

/** The most of a raw line the patterns ever see (see the cut in {@link redactLogLine}). */
export const MAX_INPUT_CHARS = 1000;

/** A JSON Web Token: three base64url segments, the first one a JSON header (`eyJ`). */
const JWT_RE = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;

/** `Bearer xxx` / `Basic xxx` as they appear in a dumped header. */
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[\w\-.~+/=]+/gi;

/** A query string or a fragment after a URL or an absolute path. Its keys and values both go. */
const QUERY_RE = /((?:[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)|(?:\/[\w\-./%…]*))\?[^\s"'<>]*/gi;
const FRAGMENT_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s#"'<>]*)#[^\s"'<>]*/gi;

/** An e-mail address. */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * A field whose VALUE is sensitive by its name, whatever the value looks like: `pin=1234`,
 * `"token":"…"`, `password: hunter2`. The name is kept, so the line still says what was there.
 */
const SENSITIVE_NAMES = [
  'pin',
  'pin[_-]?code',
  'passcode',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'client[_-]?secret',
  'token',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'ws[_-]?token',
  'fcm[_-]?token',
  'push[_-]?token',
  'auth',
  'authorization',
  'cookie',
  'set[_-]?cookie',
  'code',
  'otp',
  'cek',
  'seed',
  'private[_-]?key',
  'secret[_-]?key',
  'signing[_-]?key',
  'mnemonic',
  'e[_-]?mail',
  'phone',
  'body',
  'text',
  'content',
  'plaintext',
  'ciphertext',
];
const SENSITIVE_FIELD_RE = new RegExp(
  `\\b(${SENSITIVE_NAMES.join('|')})(["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\])]+)`,
  'gi'
);

/** An international (`+33 6 12 34 56 78`) or French national (`06 12 34 56 78`) phone number. */
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d{2}){4}|\b0[1-9](?:[\s.-]?\d{2}){4})\b/g;

/** A run that may be base64 / base64url key material, decided by {@link looksLikeKeyMaterial}. */
const B64_CANDIDATE_RE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

/** A double-quoted span, escapes included. */
const QUOTED_RE = /"((?:[^"\\]|\\.)*)"/g;

/**
 * The shapes a quoted value may keep: an identifier or enum (`ready`, `poll`, `mls.bin`,
 * `text/plain`), a number, a truncated id (`67fde7aa…`) or a marker this file already wrote.
 */
const SAFE_QUOTED_RE = /^(?:[A-Za-z0-9_$.:/…-]{0,40}|\[[a-z0-9: ]{1,24}\])$/;

/** Emoji and pictographs. Content, never a log word - except the two marks lines use as status. */
const STATUS_MARKS = String.fromCharCode(0x2713, 0x2717);
const JOINERS = [0x200d, 0xfe0f].map((c) => String.fromCharCode(c)).join('|');
// Built from code points: the formatter rewrites a regex literal's escapes into the raw characters.
const PICTOGRAPH_RE = new RegExp(
  `(?![${STATUS_MARKS}])\\p{Extended_Pictographic}|${JOINERS}`,
  'gu'
);

/** A non-ASCII LETTER: what French (or any other) prose carries and an English log line never does. */
const NON_ASCII_LETTER_RE = /(?=\P{ASCII})\p{L}/u;

/**
 * A segment of 20+ base64 characters that mixes a digit with letters is key material or a token;
 * a long word with no digit (`installConsoleIdTruncation`) is a code identifier.
 */
function isKeyLikeSegment(segment: string): boolean {
  return segment.length >= 20 && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

/**
 * Whether a base64-shaped run is key material. A `/` without `+` or padding is a PATH, so its
 * segments are judged one by one - `/api/associations/calendar/feed.ics` must survive.
 */
function looksLikeKeyMaterial(run: string): boolean {
  const isPath = run.includes('/') && !run.includes('+') && !run.endsWith('=');
  if (!isPath) return isKeyLikeSegment(run.replace(/=+$/, ''));
  return run.split('/').some(isKeyLikeSegment);
}

/** What one line became, and how many values were taken out of it. */
export interface RedactedLine {
  line: string;
  redactions: number;
}

/**
 * Returns `raw` as it may be written to the exportable log. Every value removed is replaced by a
 * marker and counted, so the export can say how much it withheld.
 */
export function redactLogLine(raw: string): RedactedLine {
  let redactions = 0;
  const count =
    (marker: string | ((...m: string[]) => string)) =>
    (...m: string[]): string => {
      redactions++;
      return typeof marker === 'string' ? marker : marker(...m);
    };

  // THE INPUT IS CUT BEFORE ANY PATTERN RUNS. Several patterns below scan forward from every
  // position of a long run with no separator, so their cost grows with the square of its length: a
  // 32 KB line took MINUTES (measured 2026-10-13). The cut goes back to the last space so it never
  // leaves the unrecognisable half of a secret (`jean@em`) as the line's last word.
  let line = raw;
  if (line.length > MAX_INPUT_CHARS) {
    const head = line.slice(0, MAX_INPUT_CHARS);
    const space = head.lastIndexOf(' ');
    line = `${space > 0 ? head.slice(0, space) : ''} [cut ${raw.length} chars]`;
    redactions++;
  }

  // One physical line per entry: a newline would let a dumped body start a line of its own.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  line = line.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' | ');

  line = line.replace(JWT_RE, count('[jwt]'));
  line = line.replace(
    AUTH_SCHEME_RE,
    count((m) => `${m.split(/\s+/)[0]} [secret]`)
  );
  line = line.replace(
    QUERY_RE,
    count((_m, base) => `${base}?[query]`)
  );
  line = line.replace(
    FRAGMENT_RE,
    count((_m, base) => `${base}#[fragment]`)
  );
  line = line.replace(EMAIL_RE, count('[email]'));
  line = line.replace(
    SENSITIVE_FIELD_RE,
    count((_m, name, sep) => `${name}${sep}[redacted]`)
  );
  line = line.replace(PHONE_RE, count('[phone]'));
  line = truncateLogIds(line);
  line = line.replace(B64_CANDIDATE_RE, (run) => {
    if (!looksLikeKeyMaterial(run)) return run;
    redactions++;
    return `[key:${run.length}]`;
  });
  line = line.replace(QUOTED_RE, (whole, inner: string) => {
    if (SAFE_QUOTED_RE.test(inner)) return whole;
    redactions++;
    return `"[${inner.length} chars]"`;
  });
  // A value cut mid-string by the payload renderer leaves ONE quote open, and the pairing above
  // leaves it to the last one: everything after it is the unchecked half of a value.
  if ((line.match(/"/g)?.length ?? 0) % 2 === 1) {
    redactions++;
    line = `${line.slice(0, line.lastIndexOf('"'))}"[cut]`;
  }
  line = line.replace(PICTOGRAPH_RE, count(''));
  line = line.replace(/\S+/g, (word) => {
    if (!NON_ASCII_LETTER_RE.test(word)) return word;
    redactions++;
    return '[text]';
  });

  if (line.length > MAX_LOG_LINE_CHARS) {
    line = `${line.slice(0, MAX_LOG_LINE_CHARS)}… (${line.length} chars)`;
  }
  return { line, redactions };
}

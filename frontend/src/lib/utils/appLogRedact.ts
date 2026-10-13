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
 * WHAT IT CANNOT CATCH, said here so nobody believes otherwise: an UNQUOTED ASCII word that happens
 * to be a name (`Joined channel #bureau`, `Jolan Boudin left`, a path segment `/users/jolan`, an
 * Error's message a server wrote), a quoted one written in lower case (`"bureau"`), and a short
 * byte list (`[201,202,203]`, under the sixteen {@link BYTE_LIST_RE} needs). No pattern separates
 * `bureau` from `ready`. The
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

/** An e-mail address, `@` written out or percent-encoded in a path (`jean%40emse.fr`). */
const EMAIL_RE = /[\w.+-]+(?:@|%40)[\w-]+(?:\.[\w-]+)+/gi;

/** The token of an invitation link (`/c/join/<token>`, `/g/join/<token>`): it admits whoever holds it. */
const JOIN_TOKEN_RE = /(\/join\/)[\w-]+/g;

/**
 * The LAST WORD of a field name that makes its value sensitive, whatever the value looks like:
 * `pin=1234`, `"token":"…"`, `newPin: 5678`, `user_pin=1`, `uploadToken=…`. The name is split on
 * camelCase, `_` and `-` before it is judged, so a prefix never hides it - a list of whole names
 * missed `userPin`, `sessionToken` and `displayName` (review of #1819, 2026-10-13).
 */
const SENSITIVE_LAST_WORDS = new Set([
  'pin',
  'pincode',
  'passcode',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'auth',
  'authorization',
  'cookie',
  'otp',
  'cek',
  'seed',
  'email',
  'mail',
  'phone',
  'tel',
  'mobile',
  // The refresh credential (`canari_refresh=`, `X-Canari-Refresh:`) and the OIDC subject.
  'refresh',
  'sub',
  // Where a member is.
  'ip',
  'lat',
  'lng',
  'lon',
  'latitude',
  'longitude',
]);

/**
 * Last words whose value is PROSE a member wrote or is called by: an unquoted value runs to the
 * next separator, not the next space, because `name: Jean Dupont` is one value of two words.
 */
const PROSE_LAST_WORDS = new Set([
  'name',
  'username',
  'nickname',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'login',
  'alias',
  'label',
  'filename',
  // What a member typed to FIND someone is a name as often as not (review of #1819, 2026-10-13).
  'search',
  'query',
  'q',
  'mnemonic',
  'phrase',
  'title',
  'preview',
  'note',
  'caption',
  'description',
  'subject',
  'body',
  'text',
  'content',
  'plaintext',
  'ciphertext',
  // `[SEND] ... contact="jolan"`: the name of who a member writes to, lower case and one word.
  'contact',
  'comment',
  'draft',
  'snippet',
  'excerpt',
]);

/** `code` and `key` are sensitive only after these words: `statusCode` and `conversationKey` are not. */
const SENSITIVE_CODE_PREFIXES = new Set([
  'invite',
  'auth',
  'authorization',
  'verification',
  'otp',
  'pin',
  'recovery',
  'access',
  'join',
]);
const SENSITIVE_KEY_PREFIXES = new Set([
  'private',
  'secret',
  'signing',
  'api',
  'encryption',
  'wrap',
  'wrapping',
  'device',
  'master',
  'session',
  'content',
]);

/** Whether a field's name says its value is a secret, `'prose'` when the value is also prose. */
function fieldSensitivity(name: string): false | 'secret' | 'prose' {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? '';
  const previous = words.at(-2) ?? '';
  if (PROSE_LAST_WORDS.has(last)) return 'prose';
  if (SENSITIVE_LAST_WORDS.has(last)) return 'secret';
  if (last === 'code' && (words.length === 1 || SENSITIVE_CODE_PREFIXES.has(previous))) {
    return 'secret';
  }
  if (last === 'key' && SENSITIVE_KEY_PREFIXES.has(previous)) return 'secret';
  return false;
}

/**
 * `name<sep>value<tail>`. The value is a quoted string (closed or CUT - the payload renderer cuts at
 * 240 characters and leaves the quote open, and the rest of the line is then that value), a bracketed
 * list or object, or a bare word; the tail is the words that follow up to the next separator, which
 * is the rest of a prose value. A field that is not sensitive is put back with its value and tail
 * scanned again, so `mode=x pin=1234` still loses the PIN.
 */
const FIELD_RE =
  /\b([A-Za-z][\w-]*)(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)|\[[^\]]*(?:\]|$)|\{[^}]*(?:\}|$)|[^\s,;&}\])|]+)((?:[ \t]+(?!["']?[A-Za-z][\w-]*["']?\s*[:=])[^\s,;&}\])|"]+)*)/g;

/**
 * What follows a prose value past a comma or a semicolon, up to the next field: `description:
 * hello, my plan` is ONE value (review of #1819, 2026-10-13). {@link redactFields} marks where each
 * prose value ended with {@link PROSE_END}, and this runs only on a line that has one - its lookahead
 * inside a repetition is the shape that costs a regex engine most, so it is kept off every other line.
 */
const PROSE_REST_RE = new RegExp(
  `${String.fromCharCode(1)}(?:[,;]?[ \\t]+(?!"?[A-Za-z][\\w-]*["']?\\s*[:=])[^\\s,;&}\\])|"]+)*`,
  'g'
);

/** A control character, so never in a line by now: they are all replaced before this stage. */
const PROSE_END = String.fromCharCode(1);

/**
 * A secret's name followed by its value with no `:` or `=` between them - `pin 482913`,
 * `otp -> 482913`, an Error's `Invalid PIN 482913`. Only a value carrying a digit goes, so the
 * sentence `PIN verified` keeps its verb.
 */
const SECRET_WORD_VALUE_RE =
  /\b(pin|otp|passcode|password|passphrase|token|secret)(\s*(?:->|=>|is)?\s+)(?=[^\s,;]*\d)[^\s,;]{4,}/gi;

/** An exception's class name (`NotAllowedError`, `AbortError`): what a failure IS, never a person. */
const ERROR_NAME_RE = /^"?[A-Z][A-Za-z]*(?:Error|Exception)"?$/;

/**
 * The two values a sensitive NAME may still carry harmlessly, both measured on the real call sites
 * (review of #1819, 2026-10-13): `{"name":"NotAllowedError"}` from a refused `play()`, and a bare
 * `code` holding a short status (`MediaError.code` 1-4, a WebSocket close code 1000-4999) - an OIDC
 * or invitation code is never four digits.
 */
function isHarmlessFieldValue(name: string, value: string, tail: string): boolean {
  if (tail !== '') return false;
  if (ERROR_NAME_RE.test(value)) return true;
  return name.toLowerCase() === 'code' && /^\d{1,4}$/.test(value);
}

/** `[N chars]` for a content value (`"[N chars]"` when it was quoted), N excluding the quotes. */
function proseMarker(value: string, tail: string): string {
  const quoted = value.startsWith('"');
  const bare = quoted ? value.replace(/^"/, '').replace(/"$/, '') : value;
  const marker = `[${bare.length + tail.length} chars]`;
  return quoted ? `"${marker}"` : marker;
}

/**
 * Replaces the value of every sensitive field by `[redacted]`, calling `onRedact` once per value.
 * Recursion is on a strictly shorter span (a value or a tail), so it ends.
 */
function redactFields(text: string, onRedact: () => void): string {
  const out = text.replace(
    FIELD_RE,
    (_m, name: string, sep: string, value: string, tail: string) => {
      const sensitivity = fieldSensitivity(name);
      if (sensitivity === false || isHarmlessFieldValue(name, value, tail)) {
        return `${name}${sep}${redactFields(value, onRedact)}${redactFields(tail, onRedact)}`;
      }
      onRedact();
      // A CONTENT field is replaced by its LENGTH whatever the value looks like: `text="ok"` is
      // an identifier by shape and a member's whole message by meaning.
      if (sensitivity === 'prose') return `${name}${sep}${proseMarker(value, tail)}${PROSE_END}`;
      return `${name}${sep}[redacted]${redactFields(tail, onRedact)}`;
    }
  );
  return out.includes(PROSE_END) ? out.replace(PROSE_REST_RE, '') : out;
}

/**
 * An international (`+33 6 12 34 56 78`, `0033 6 12 34 56 78`) or French national
 * (`06 12 34 56 78`) phone number.
 */
const PHONE_RE =
  /(?:(?:\+|\b00)\d{1,3}[\s.-]?\d(?:[\s.-]?\d{2}){4}|\b0[1-9](?:[\s.-]?\d{2}){4})\b/g;

/** A run that may be base64 / base64url key material, decided by {@link looksLikeKeyMaterial}. */
const B64_CANDIDATE_RE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

/** A double-quoted span, escapes included. */
const QUOTED_RE = /"((?:[^"\\]|\\.)*)"/g;

/**
 * The other ways a line quotes a value - `'Bureau'`, a backtick, curly quotes, guillemets - judged
 * by the same allowlist (review of #1819, 2026-10-13: only `"` was). A single quote opens only after
 * a non-word and closes only before one, so the apostrophes of `member's` and `can't` never pair.
 */
const OTHER_QUOTED_RE = new RegExp(
  [
    "(?<![\\w'])(')([^'\\n]*)'(?!\\w)",
    '(`)([^`]*)`',
    `(${String.fromCharCode(0x2018)})([^${String.fromCharCode(0x2019)}]*)${String.fromCharCode(0x2019)}`,
    `(${String.fromCharCode(0x201c)})([^${String.fromCharCode(0x201d)}]*)${String.fromCharCode(0x201d)}`,
    `(${String.fromCharCode(0xab)})([^${String.fromCharCode(0xbb)}]*)${String.fromCharCode(0xbb)}`,
  ].join('|'),
  'g'
);

/** The closing mark of each opening one {@link OTHER_QUOTED_RE} accepts. */
const CLOSING_QUOTE: Record<string, string> = {
  "'": "'",
  '`': '`',
  [String.fromCharCode(0x2018)]: String.fromCharCode(0x2019),
  [String.fromCharCode(0x201c)]: String.fromCharCode(0x201d),
  [String.fromCharCode(0xab)]: String.fromCharCode(0xbb),
};

/**
 * An IPv4 or a full-form IPv6 address: where a device is, never what a reading needs. A clock
 * (`13:32:42.123`) has two colons, an address five or more.
 */
const IP_RE = /\b(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4})\b/gi;

/**
 * Sixteen or more small integers in brackets - a key or a seed as `JSON.stringify` writes a byte
 * array. Nothing a reading needs is a list that long.
 */
const BYTE_LIST_RE = /\[\d{1,3}(?:, ?\d{1,3}){15,}\]/g;

/** One unquoted token, judged whole by {@link FILE_EXT_RE} (a scan, never a backtracking search). */
const TOKEN_RE = /[^\s"'`<>/\\,;:()[\]{}]+/g;

/**
 * The extensions of what a MEMBER uploads. A token ending in one is a file name, and a file name is
 * chosen by a person (`CV_Jolan_Boudin.pdf`); the extension is kept, the stem goes. The app's own
 * files (`mls.bin`, `feed.ics`, `*.wasm`) are not in the list and keep their names.
 */
const FILE_EXTS =
  '\\.(?:pdf|jpe?g|png|heic|heif|gif|webp|bmp|tiff?|mp4|mov|m4v|webm|avi|mkv|mp3|m4a|wav|ogg|opus|aac|docx?|xlsx?|pptx?|odt|ods|odp|txt|rtf|csv|zip|rar|7z)';
const FILE_EXT_RE = new RegExp(`${FILE_EXTS}$`, 'i');
/** The cheap test that spares nearly every line the token-by-token pass. */
const HAS_FILE_EXT_RE = new RegExp(`${FILE_EXTS}\\b`, 'i');

/**
 * Characters that render as nothing - zero-width spaces and joiners, direction marks, the emoji
 * variation selector - and would otherwise split a word past the checks below.
 */
// The selector is outside the class: inside one, a linter reads it as half of a combined character.
const INVISIBLE_RE = new RegExp('[\\u200b-\\u200f\\u2060\\ufeff]|\\ufe0f', 'g');

/**
 * The shapes a quoted value may keep: an identifier or enum (`ready`, `poll`, `mls.bin`,
 * `text/plain`), a number, a truncated id (`67fde7aa…`) or a marker this file already wrote.
 */
const SAFE_QUOTED_RE = /^(?:[A-Za-z0-9_$.:/…-]{0,40}|\[[a-z0-9: ]{1,24}\])$/;

/**
 * A Capitalised word anywhere in a quoted value (`"Jolan"`, `"CV_Jolan_Boudin.pdf"`, `"Bureau"`):
 * the shape of a name, which an identifier or an enum of this code base never has. It is what the
 * shape allowlist above let through until the review of #1819 (2026-10-13).
 */
const PROPER_NOUN_RE = /(?:^|[^A-Za-z])[A-Z][a-z]/;

/** Whether a quoted value has a shape the log may keep: an identifier, an enum, an error's class. */
function isSafeQuoted(inner: string): boolean {
  if (ERROR_NAME_RE.test(inner)) return true;
  return SAFE_QUOTED_RE.test(inner) && !PROPER_NOUN_RE.test(inner);
}

/** Emoji and pictographs. Content, never a log word - except the four marks lines use as status. */
const STATUS_MARKS = String.fromCharCode(0x2713, 0x2717, 0x26a0, 0x2139);
const STATUS_MARK_RE = new RegExp(`[${STATUS_MARKS}]`, 'g');
// Built from code points: the formatter rewrites a regex literal's escapes into the raw characters.
// The joiners (U+200D, U+FE0F) are already gone with the invisible characters.
const PICTOGRAPH_RE = new RegExp(
  `(?![${STATUS_MARKS}])\\p{Extended_Pictographic}|\\p{Regional_Indicator}`,
  'gu'
);

/**
 * A non-ASCII letter, combining mark or digit: what French (or any other) prose carries and an
 * English log line never does. Marks too: `soire` + U+0301 + `e` is an accented word with no
 * accented LETTER in it.
 */
const NON_ASCII_LETTER_RE = /(?=\P{ASCII})[\p{L}\p{M}\p{N}]/u;

/**
 * A segment of 20+ base64 characters that mixes a digit with letters is key material or a token;
 * a long word with no digit (`installConsoleIdTruncation`) is a code identifier.
 */
function isKeyLikeSegment(segment: string): boolean {
  // `VITE_CALL_E2E_ENCRYPTION`: an upper-case constant's name, which base64 is never spelled as.
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(segment)) return false;
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
  line = line.replace(INVISIBLE_RE, '');

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
  line = line.replace(
    JOIN_TOKEN_RE,
    count((_m, path) => `${path}[token]`)
  );
  line = line.replace(EMAIL_RE, count('[email]'));
  line = redactFields(line, () => redactions++);
  line = line.replace(
    SECRET_WORD_VALUE_RE,
    count((_m, word, sep) => `${word}${sep}[redacted]`)
  );
  line = line.replace(PHONE_RE, count('[phone]'));
  line = line.replace(IP_RE, count('[ip]'));
  line = line.replace(
    BYTE_LIST_RE,
    count((m) => `[${m.split(',').length} numbers]`)
  );
  line = truncateLogIds(line);
  line = line.replace(B64_CANDIDATE_RE, (run) => {
    if (!looksLikeKeyMaterial(run)) return run;
    redactions++;
    return `[key:${run.length}]`;
  });
  line = line.replace(QUOTED_RE, (whole, inner: string) => {
    if (isSafeQuoted(inner)) return whole;
    redactions++;
    return `"[${inner.length} chars]"`;
  });
  line = line.replace(OTHER_QUOTED_RE, (whole, ...groups: Array<string | undefined>) => {
    // Five alternatives of two groups each; exactly one pair matched.
    const at = groups.findIndex((g, i) => i % 2 === 0 && i < 10 && g !== undefined);
    const open = groups[at] as string;
    const inner = groups[at + 1] ?? '';
    if (isSafeQuoted(inner)) return whole;
    redactions++;
    return `${open}[${inner.length} chars]${CLOSING_QUOTE[open]}`;
  });
  if (HAS_FILE_EXT_RE.test(line)) {
    line = line.replace(TOKEN_RE, (token) => {
      const ext = FILE_EXT_RE.exec(token);
      if (!ext || token.length === ext[0].length) return token;
      redactions++;
      return `[file]${ext[0]}`;
    });
  }
  // A value cut mid-string by the payload renderer leaves ONE quote open, and the pairing above
  // leaves it to the last one: everything after it is the unchecked half of a value.
  if ((line.match(/"/g)?.length ?? 0) % 2 === 1) {
    redactions++;
    line = `${line.slice(0, line.lastIndexOf('"'))}"[cut]`;
  }
  line = line.replace(PICTOGRAPH_RE, count(''));
  line = line.replace(/\S+/g, (word) => {
    // A status mark is not prose, although U+2139 is classified as a letter.
    if (!NON_ASCII_LETTER_RE.test(word.replace(STATUS_MARK_RE, ''))) return word;
    redactions++;
    return '[text]';
  });

  if (line.length > MAX_LOG_LINE_CHARS) {
    line = `${line.slice(0, MAX_LOG_LINE_CHARS)}… (${line.length} chars)`;
  }
  return { line, redactions };
}

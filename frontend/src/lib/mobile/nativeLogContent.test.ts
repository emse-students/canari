import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NO NATIVE LOG LINE CARRIES WHAT A USER WROTE, WHO THEY ARE CALLED, OR A KEY.
 *
 * A release build logs: Android's `Log.*` reaches logcat whatever the build type (no shrinker rule
 * strips it), iOS `NSLog` lands in the unified log a sysdiagnose collects, and the Rust logger
 * writes to both and to a file. Those lines are read while debugging - which is why they exist -
 * and they are also read by anything that collects a device's logs. So they carry ids, counts,
 * states and reasons, and never the text of a message, a name, an emoji, a seed, a secret or a
 * token. The rule is in `docs/wiki/frontend/mobile.md` ("What a native log line may carry").
 *
 * Nothing types a value as "content", so no compiler sees a log line that prints one. This test
 * reads every native source the app ships and refuses any log call that INTERPOLATES an expression
 * naming a content-bearing value - unless the expression only measures it (`.length`, `!= null`,
 * `isEmpty`...), which is how a line says "there was a body" without saying what it was.
 *
 * It is a DENYLIST of names, and that is its limit: a content value renamed to something neutral
 * walks past it. The list is therefore wide, and a new name for content goes into it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = resolve(here, '../../../src-tauri');
const FRONTEND = resolve(here, '../../..');

type Lang = 'kotlin' | 'swift' | 'objc' | 'rust';

/** Every native source tree the shipped app compiles, by language. */
const TREES: { dir: string; lang: Lang; ext: string }[] = [
  {
    dir: join(SRC_TAURI, 'gen/android/app/src/main/java/fr/emse/canari'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-customtabs/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'plugins/tauri-plugin-gallery/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  {
    dir: join(SRC_TAURI, 'patches/tauri-plugin-keystore/android/src/main'),
    lang: 'kotlin',
    ext: '.kt',
  },
  { dir: join(SRC_TAURI, 'gen/apple/canari_NSE'), lang: 'swift', ext: '.swift' },
  { dir: join(SRC_TAURI, 'gen/apple/canari_Share'), lang: 'swift', ext: '.swift' },
  { dir: join(SRC_TAURI, 'gen/apple/Sources/canari'), lang: 'objc', ext: '.mm' },
  {
    dir: join(SRC_TAURI, 'patches/tauri-plugin-keystore/ios/Sources'),
    lang: 'swift',
    ext: '.swift',
  },
  { dir: join(SRC_TAURI, 'src'), lang: 'rust', ext: '.rs' },
  { dir: join(FRONTEND, 'mls-core/src'), lang: 'rust', ext: '.rs' },
];

/** Tauri regenerates this directory; its one logger (`app.tauri.Logger`) is silent in release. */
const SKIPPED_DIRS = new Set(['generated']);

/**
 * Names whose value is content, a name or a secret. Matched case-insensitively against every
 * identifier and every string key (`data["senderName"]`) an interpolated expression mentions.
 */
const CONTENT_NAMES = [
  'text',
  'body',
  'content',
  'plaintext',
  'plain',
  'decrypted',
  'title',
  'subtitle',
  'preview',
  'caption',
  'reply',
  'replyText',
  'emoji',
  'senderName',
  'sender_name',
  'actorName',
  'actor_name',
  'authorName',
  'author_name',
  'groupName',
  'group_name',
  'channelName',
  'channel_name',
  'workspaceName',
  'workspace_name',
  'displayName',
  'display_name',
  'userName',
  'user_name',
  'fullName',
  'firstName',
  'lastName',
  'seed',
  'seedB64',
  'seed_b64',
  'deviceKey',
  'deviceKeyB64',
  'device_key',
  'device_key_b64',
  'keyB64',
  'key_b64',
  'keyBytes',
  'key_bytes',
  'secret',
  'pushSecret',
  'push_secret',
  'token',
  'fcmToken',
  'voipToken',
  'pin',
  'password',
].map((n) => n.toLowerCase());

/** An expression that only MEASURES a value says nothing of what it holds. */
const MEASURES =
  /\.(length|size|count|len\(\)|isEmpty|isNotEmpty|isNullOrEmpty|isNullOrBlank|is_empty\(\)|is_some\(\)|is_none\(\))|[!=]=\s*(null|nil)\b/;

/**
 * Calls that hand back (part of) the value they are called on: `body.take(60)` is still the body.
 * A chain's VALUE is its last segment that is not one of these - `decrypted.callEnded` is a flag,
 * `seed["sessionId"]` is an id.
 */
const PASS_THROUGH = new Set(
  [
    'take',
    'takeLast',
    'prefix',
    'suffix',
    'substring',
    'substringToIndex',
    'slice',
    'trim',
    'trimmed',
    'lowercase',
    'uppercase',
    'lowercased',
    'uppercased',
    'toString',
    'description',
    'orEmpty',
    'as_str',
    'as_deref',
    'unwrap',
    'unwrap_or',
    'unwrap_or_default',
    'to_string',
    'to_owned',
    'clone',
    'UTF8String',
  ].map((n) => n.toLowerCase())
);

/**
 * The lines the scanner misreads, each with WHY the value is not content. Keyed by file name and the
 * exact expression, so the same expression appearing anywhere else is still checked.
 */
const NOT_CONTENT: Record<string, string> = {
  // A comparison: the line says whether the token changed, never the token.
  'CanariBootReceiver.kt|if (token == previous) "unchanged" else "ROTATED"': 'comparison',
  // `content` is the keyboard geometry (a CGFloat) and the WebView's content view, not a message.
  'canari_ios.mm|content': 'geometry',
  'canari_ios.mm|[content class]': 'class name',
  'canari_ios.mm|NSStringFromClass([content class])': 'class name',
  // A comparison of two seeds: the line prints true or false.
  'push.rs|same_seed(held_seed, seed.seed_b64)': 'comparison',
  // `token` on a key-group join settlement is its OUTCOME LABEL (a settled or stopped reason), never a credential.
  'CanariFirebaseMessagingService.kt|settlement.token': 'outcome label',
  'CanariFirebaseMessagingService.kt|stop.token': 'outcome label',
};

interface Finding {
  file: string;
  line: number;
  expr: string;
}

function walk(dir: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) out.push(...walk(path, ext));
    } else if (name.endsWith(ext)) {
      out.push(path);
    }
  }
  return out;
}

/** The log calls of each language, up to and including the opening parenthesis. */
const CALL_START: Record<Lang, RegExp> = {
  kotlin: /\bLog\.(v|d|i|w|e|wtf|println)\s*\(/g,
  swift:
    /\b(NSLog|os_log|print)\s*\(|\b(?:logger|log)\.(debug|info|notice|error|fault|warning)\s*\(/g,
  objc: /\bNSLog\s*\(/g,
  rust: /\b(?:log::)?(trace|debug|info|warn|error)!\s*\(|\b(println|eprintln)!\s*\(/g,
};

/**
 * Reads one call from just after its `(` to its matching `)`, and returns every expression whose
 * VALUE reaches the log line: the interpolations inside string literals (`$x`, `${...}`, `\(...)`,
 * Rust's `{x}`) and every argument that is not a string literal.
 */
function callExpressions(src: string, start: number, lang: Lang): string[] {
  const exprs: string[] = [];
  let i = start;
  let depth = 1;
  let arg = '';
  const flushArg = () => {
    const a = arg.trim();
    // A bare literal (the format string, a tag spelled inline) is text the source wrote: its
    // interpolations were collected while it was read.
    if (/[A-Za-z_]/.test(withoutStrings(a))) exprs.push(a);
    arg = '';
  };
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || (lang === 'objc' && c === '@' && src[i + 1] === '"')) {
      const quoteAt = c === '@' ? i + 1 : i;
      const triple = lang === 'kotlin' && src.startsWith('"""', quoteAt);
      const end = readString(src, quoteAt + (triple ? 3 : 1), lang, triple, exprs);
      // Kept in the argument: a quoted KEY (`seed["sessionId"]`) is what names the value.
      arg += src.slice(quoteAt, end);
      i = end;
      continue;
    }
    if (
      lang === 'rust' &&
      c === 'r' &&
      /r#*"/.test(src.slice(i, i + 4)) &&
      !/\w/.test(src[i - 1])
    ) {
      const hashes = /^r(#*)"/.exec(src.slice(i))![1];
      const close = '"' + hashes;
      const end = src.indexOf(close, i + 2 + hashes.length);
      const body = src.slice(i + 2 + hashes.length, end);
      for (const m of body.matchAll(/\{([A-Za-z_][A-Za-z0-9_.]*)(:[^}]*)?\}/g)) exprs.push(m[1]);
      i = end + close.length;
      continue;
    }
    if (c === "'" && lang !== 'rust') {
      // A character literal: skip it so a quote or a paren inside cannot unbalance the scan.
      const end = src.indexOf("'", i + (src[i + 1] === '\\' ? 3 : 2));
      i = end + 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0) break;
    if (c === ',' && depth === 1) {
      flushArg();
    } else {
      arg += c;
    }
    i++;
  }
  flushArg();
  return exprs;
}

/** Skips a string literal starting at `i` (just past its opening quote), collecting interpolations. */
function readString(src: string, i: number, lang: Lang, triple: boolean, exprs: string[]): number {
  let literal = '';
  while (i < src.length) {
    const c = src[i];
    if (!triple && c === '\\') {
      if (lang === 'swift' && src[i + 1] === '(') {
        const end = matching(src, i + 2, '(', ')');
        exprs.push(src.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      i += 2;
      continue;
    }
    if (triple ? src.startsWith('"""', i) : c === '"') {
      if (lang === 'rust') {
        for (const m of literal.matchAll(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_.]*)(:[^}]*)?\}/g)) {
          exprs.push(m[1]);
        }
      }
      return i + (triple ? 3 : 1);
    }
    if (lang === 'kotlin' && c === '$') {
      if (src[i + 1] === '{') {
        const end = matching(src, i + 2, '{', '}');
        exprs.push(src.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (m) {
        exprs.push(m[1]);
        i += m[0].length;
        continue;
      }
    }
    literal += c;
    i++;
  }
  return i;
}

/** Index just past the `"` closing a string literal whose body starts at `i`, escapes honoured. */
function endOfString(s: string, i: number): number {
  while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** `s` with every string literal removed. */
function withoutStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      i = endOfString(s, i + 1);
      out += '""';
    } else {
      out += s[i++];
    }
  }
  return out;
}

/** Index of the bracket closing the one opened just before `i`, skipping nested string literals. */
function matching(src: string, i: number, open: string, close: string): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = src.indexOf('"', i + 1) + 1;
      continue;
    }
    if (c === open) depth++;
    if (c === close && --depth === 0) return i;
    i++;
  }
  return i;
}

/**
 * The VALUE name of every chain an expression contains, lower-cased: for `a.b["c"].take(3)` that is
 * `c`, the last segment that is not a {@link PASS_THROUGH} call. Arguments of a call are chains of
 * their own, so `render(text)` still names `text`.
 */
function valueNamesIn(expr: string): string[] {
  const names: string[] = [];
  const chain = /[A-Za-z_][A-Za-z0-9_]*/y;
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"') {
      // A bare string literal is text the source wrote, not a value; a quoted KEY is handled below.
      i = endOfString(expr, i + 1);
      continue;
    }
    chain.lastIndex = i;
    const root = /[A-Za-z_]/.test(c) && !/[\w.]/.test(expr[i - 1] ?? '') ? chain.exec(expr) : null;
    if (!root) {
      i++;
      continue;
    }
    const segments = [root[0]];
    let j = chain.lastIndex;
    for (;;) {
      const rest = expr.slice(j);
      const field = /^\s*\??(?:\.|!!\.)\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      const key = /^\s*\[\s*"([^"]*)"\s*\]/.exec(rest);
      const call = /^\s*\(/.exec(rest);
      if (field) {
        segments.push(field[1]);
        j += field[0].length;
      } else if (key) {
        segments.push(key[1]);
        j += key[0].length;
      } else if (call) {
        // The call's arguments are scanned as chains of their own; the chain itself continues. A
        // call whose one argument is a quoted key (`optString("text")`) reads THAT key.
        const close = matching(expr, j + call[0].length, '(', ')');
        const args = expr.slice(j + call[0].length, close);
        const quotedKey = /^\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*$/.exec(args);
        if (quotedKey) segments.push(quotedKey[1]);
        names.push(...valueNamesIn(args));
        j = close + 1;
      } else {
        break;
      }
    }
    const value = [...segments].reverse().find((s) => !PASS_THROUGH.has(s.toLowerCase()));
    if (value) names.push(value.toLowerCase());
    i = j;
  }
  return names;
}

/** An Apple error's TEXT: it often quotes the file it failed on - a shared file's name, a path. */
const ERROR_TEXT = /\blocalized(Description|FailureReason|RecoverySuggestion)\b/;

/**
 * Whether an interpolated expression puts content into the line. `redacting` is true for a Swift
 * `Logger` call ONLY: there an interpolation is private unless marked public, so an error text is
 * redacted in release. `NSLog`, Swift `print`, `os_log` with a `%@` and every Rust and Kotlin logger
 * write it out whole - so there an error text is content, and the line says the error's domain and
 * code instead.
 */
export function leaksContent(expr: string, redacting = false): boolean {
  if (MEASURES.test(expr)) return false;
  if (ERROR_TEXT.test(expr)) return !redacting || /privacy:\s*\.public\b/.test(expr);
  return valueNamesIn(expr).some((n) => CONTENT_NAMES.includes(n));
}

/** Whether the call `CALL_START` matched is a Swift `Logger` method (`logger.info(`, `log.error(`). */
function isRedactingCall(lang: Lang, call: string): boolean {
  return lang === 'swift' && /^(?:logger|log)\./.test(call);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const tree of TREES) {
    for (const file of walk(tree.dir, tree.ext)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(CALL_START[tree.lang])) {
        // The first argument of a Rust or ObjC call is the format string; Kotlin's first is the
        // tag. Every argument is checked: a variable handed in whole is as much the line as a
        // template is.
        const redacting = isRedactingCall(tree.lang, m[0]);
        for (const expr of callExpressions(src, m.index! + m[0].length, tree.lang)) {
          const name = file.split(/[\\/]/).pop();
          if (leaksContent(expr, redacting) && !NOT_CONTENT[`${name}|${expr}`]) {
            findings.push({ file: relative(FRONTEND, file), line: lineOf(src, m.index!), expr });
          }
        }
      }
    }
  }
  return findings;
}

describe('the scanner', () => {
  it('reads the interpolations of every language it guards', () => {
    expect(callExpressions('TAG, "a=$body b=${x.take(3)}")', 0, 'kotlin')).toEqual([
      'TAG',
      'body',
      'x.take(3)',
    ]);
    expect(callExpressions('"a=\\(text.prefix(8))")', 0, 'swift')).toEqual(['text.prefix(8)']);
    expect(callExpressions('@"a=%@", senderName)', 0, 'objc')).toEqual(['senderName']);
    expect(callExpressions('"a={text} b={}", seed_b64)', 0, 'rust')).toEqual(['text', 'seed_b64']);
  });

  it('refuses content and lets a measurement of it through', () => {
    expect(leaksContent('body.take(60)')).toBe(true);
    expect(leaksContent('data["senderName"]')).toBe(true);
    expect(leaksContent('json.optString("text")')).toBe(true);
    expect(leaksContent('text.length')).toBe(false);
    expect(leaksContent('name != null')).toBe(false);
    expect(leaksContent('groupId.take(8)')).toBe(false);
    expect(leaksContent('decrypted.callEnded')).toBe(false);
    expect(leaksContent('seed["sessionId"].as_str().unwrap_or_default()')).toBe(false);
    expect(leaksContent('renderMentions(text, myUserId).take(200)')).toBe(true);
    expect(leaksContent('msg.text')).toBe(true);
    // An error text is content wherever nothing redacts it: NSLog, print, Rust, Kotlin.
    expect(leaksContent('error.localizedDescription')).toBe(true);
    expect(leaksContent('[error localizedDescription]')).toBe(true);
    expect(leaksContent('err.localizedFailureReason')).toBe(true);
    // In a Swift Logger call it is private unless marked public.
    expect(leaksContent('error.localizedDescription', true)).toBe(false);
    expect(leaksContent('error.localizedDescription, privacy: .public', true)).toBe(true);
    expect(leaksContent('error.localizedDescriptionX, privacy: .publicX', true)).toBe(false);
    // The error's domain and code are what an unredacted line says instead.
    expect(leaksContent('failure.domain')).toBe(false);
    expect(leaksContent('(long)failure.code')).toBe(false);
  });

  it('exempts a Swift Logger call alone from naming an error text', () => {
    expect(isRedactingCall('swift', 'log.warning(')).toBe(true);
    expect(isRedactingCall('swift', 'logger.error(')).toBe(true);
    expect(isRedactingCall('swift', 'NSLog(')).toBe(false);
    expect(isRedactingCall('swift', 'print(')).toBe(false);
    expect(isRedactingCall('objc', 'NSLog(')).toBe(false);
    expect(isRedactingCall('rust', 'log::error!(')).toBe(false);
  });

  it('finds the native sources it is meant to read', () => {
    for (const tree of TREES) expect(walk(tree.dir, tree.ext).length).toBeGreaterThan(0);
  });
});

describe('native log lines in every build', () => {
  it('carry no message text, name, emoji, seed, secret or token', () => {
    const findings = scan();
    expect(findings.map((f) => `${f.file}:${f.line} interpolates \`${f.expr}\``)).toEqual([]);
  });
});

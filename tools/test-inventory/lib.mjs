/**
 * The pure half of the test inventory: parsing a test file into cases, a purpose and a "does it read
 * source text" verdict, with no git, no network and no filesystem access of its own, so
 * `lib.test.mjs` can pin every reading on a string. `inventory.mjs` is the half that touches the world.
 *
 * Everything here is a STATIC reading (a regex over text). A count made this way is a lower bound for
 * a generated case (`it.each`), which is why a suite carries `dynamicCases`, and why `inventory.mjs`
 * prefers a runner's own JSON report for the number when it is given one.
 */

/** A case declaration at the start of a line: `it(`, `test.skip(`, `it.each([...])(`, `it.concurrent(`. */
const CASE_RE =
  /^(\s*)(?:it|test)((?:\.(?:only|skip|todo|concurrent|fails|sequential|runIf|skipIf))*)(\.each\b)?/;
const DESCRIBE_RE = /^\s*describe(?:\.\w+)*(?:\.each\b[^(]*)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
const TITLE_RE = /(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;

/**
 * Cases of a vitest/jest/bun-test file.
 * @param {string} text the file's source
 * @returns {{cases: {title: string, line: number, skipped: boolean, dynamic: boolean, body: string}[], describes: string[]}}
 */
export function parseJsTests(text) {
  const lines = text.split('\n');
  const cases = [];
  const describes = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const d = DESCRIBE_RE.exec(line);
    if (d) describes.push(d[2]);
    const m = CASE_RE.exec(line);
    if (!m) continue;
    // `it` / `test` followed by something that is not a call is an identifier (`item`, `test_x`).
    const rest = line.slice(m[0].length);
    if (!m[3] && !rest.startsWith('(')) continue;
    const indent = m[1].length;
    const t = TITLE_RE.exec(line) ?? TITLE_RE.exec(`${line} ${lines[i + 1] ?? ''}`);
    // The body runs to the first later line at the SAME indent that closes the call (oxfmt layout).
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const ind = l.length - l.trimStart().length;
      if (l.trim() !== '' && ind <= indent && /^\s*[})]/.test(l)) {
        end = j;
        break;
      }
      end = j;
    }
    cases.push({
      title: t ? t[2] : '',
      line: i + 1,
      skipped: /\.(skip|todo)\b/.test(m[2]),
      dynamic: Boolean(m[3]),
      body: lines.slice(i, end + 1).join('\n'),
    });
  }
  return { cases, describes };
}

/** Count `#[test]` / `#[tokio::test]` / `#[ignore]` in a Rust file. */
export function parseRustTests(text) {
  const tests = (text.match(/^\s*#\[(?:tokio::|async_std::)?test(?:\(.*\))?\]/gm) ?? []).length;
  const ignored = (text.match(/^\s*#\[ignore/gm) ?? []).length;
  const names = [...text.matchAll(/^\s*(?:async\s+)?fn\s+(\w+)/gm)].map((m) => m[1]);
  return { cases: tests, ignored, names };
}

/** Count `@Test` methods of a Kotlin file. */
export function parseKotlinTests(text) {
  const names = [...text.matchAll(/@Test[^\n]*\n\s*fun\s+`?([^`(]+)`?\(/g)].map((m) => m[1]);
  return { cases: names.length, names };
}

/** Assertion-ish lines of a script that is its own runner (`.mjs` self-test, `.sh` test). */
export function parseScriptAssertions(text, ext) {
  if (ext === 'sh') {
    return (text.match(/^\s*(?:url|expect|assert\w*|check\w*|ok|case_\w+)\s+["'$\w]/gm) ?? [])
      .length;
  }
  return (text.match(/\b(?:assert(?:\.\w+)?|expect|check|ok|fail)\(/g) ?? []).length;
}

/**
 * One line saying what a file guards, taken from its top docblock, or - failing that - from its
 * describe/case names. `unknown` is the honest answer when neither exists.
 * @returns {{purpose: string, source: 'docblock'|'describe'|'cases'|'unknown'}}
 */
export function derivePurpose(text, describes = [], caseTitles = []) {
  // The first JSDoc-style block within the first 2,000 characters: this repository often puts it AFTER the imports.
  const found = /\/\*\*([\s\S]*?)\*\//.exec(text.slice(0, 2000));
  const block = found ?? /^\s*(?:#!.*\n)?\s*\/\*([\s\S]*?)\*\//.exec(text);
  const hashHeader = /^(?:#!.*\n)?((?:#[^\n]*\n)+)/.exec(text);
  const raw = block
    ? block[1].replace(/^\s*\*\s?/gm, '')
    : hashHeader
      ? hashHeader[1].replace(/^#+\s?/gm, '')
      : '';
  const cleaned = raw
    .replace(/^[\s=\-#]+$/gm, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(usage|bun |@)/i.test(l));
  if (cleaned.length > 0) {
    // First paragraph, up to the first sentence end, capped.
    const para = [];
    for (const l of cleaned) {
      para.push(l);
      if (/[.!?:]$/.test(l)) break;
    }
    const s = para.join(' ').replace(/\s+/g, ' ');
    const first = /^(.{20,}?[.!?])(\s|$)/.exec(s)?.[1] ?? s;
    return { purpose: clip(first, 200), source: 'docblock' };
  }
  if (describes.length > 0)
    return { purpose: clip(describes.slice(0, 2).join(' / '), 200), source: 'describe' };
  const titles = caseTitles.filter(Boolean);
  if (titles.length > 0)
    return { purpose: clip(titles.slice(0, 2).join(' / '), 200), source: 'cases' };
  return { purpose: 'unknown', source: 'unknown' };
}

/** @param {string} s */
function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s;
}

const NATIVE_EXT = /\.(kt|swift|plist|xml|gradle|kts|entitlements|rs|toml|properties|pbxproj)\b/;
const DOC_EXT = /(\.(md|yml|yaml)\b|\bdocs\/|\.github|changelog\.d|\bMakefile)/;
const APP_EXT = /\.(ts|svelte|css|js|mjs|html|json)\b/;

/**
 * Does the file read a file of the tree as TEXT, and which kind? The kind comes from the extensions
 * of the path literals on the lines that read or build a path - a heuristic, named as one.
 * @returns {{readsFiles: boolean, kind: 'none'|'app-source'|'native-contract'|'docs-ci'}}
 */
export function classifyTextReads(text) {
  const reads = /\b(?:readFileSync|readdirSync|readFile|readdir)\b|\?raw\b|\?inline\b/.test(text);
  if (!reads) return { readsFiles: false, kind: 'none' };
  const pathLines = text
    .split('\n')
    .filter((l) =>
      /\b(?:readFileSync|readdirSync|readFile|readdir|join|resolve|new URL)\b|\?raw|\bpath\b|\bROOT\b/i.test(
        l
      )
    )
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  if (NATIVE_EXT.test(pathLines)) return { readsFiles: true, kind: 'native-contract' };
  if (DOC_EXT.test(pathLines) && !/\bsrc\b|\.svelte|\.ts['"`]/.test(pathLines))
    return { readsFiles: true, kind: 'docs-ci' };
  if (APP_EXT.test(pathLines) || /\?raw/.test(text))
    return { readsFiles: true, kind: 'app-source' };
  return { readsFiles: true, kind: 'none' };
}

/**
 * Imports of application code (not Node built-ins, not the test framework, not test helpers).
 * A file that reads source text AND imports none exercises no code at all: it is pure text.
 */
export function appImports(text) {
  const out = [];
  for (const m of text.matchAll(/^\s*import\s+(?:type\s+)?(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) {
    const spec = m[1];
    if (/^(node:|vitest|bun:|fake-indexeddb|happy-dom|@testing-library|svelte(\/|$))/.test(spec))
      continue;
    if (/\/test\/|\.test\b|\/testing\//.test(spec)) continue;
    if (/^[a-z@][^$./]*$/.test(spec) && !spec.startsWith('$')) continue; // bare npm package
    out.push(spec);
  }
  return out;
}

/** Does the file mount a component or touch the DOM? (the `environment: node` question) */
export function touchesDom(text) {
  return /\bmount\(|\brender\(|\bdocument\.|\bwindow\.|querySelector|\bflushSync\b/.test(text);
}

/** Snapshot assertions in a JS test file. */
export function snapshotCount(text) {
  return (text.match(/\.(?:toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot)\(/g) ?? [])
    .length;
}

/** Whitespace-insensitive fingerprint of a case body, comments dropped, title kept out of it. */
export function bodyKey(body) {
  return body
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('');
}

/** The stem two sibling tests share: `AssociationTile.render.svelte.test.ts` -> `AssociationTile`. */
export function stemOf(file) {
  const base = file.split('/').pop() ?? file;
  return base.split('.')[0];
}

/**
 * Names that a markdown section backticks, as a set of stems (`foo.test.ts` and `foo` both give `foo`).
 * Used to read the WP-T5 triage's own KEEP list without re-deriving it.
 */
export function backtickedStems(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/`([A-Za-z0-9_.\-/]+)`/g)) {
    const tok = m[1];
    if (tok.endsWith('/')) continue;
    // `useNotifications.webClick/.tapListener` names a family: its first segment's stem is the file.
    for (const seg of [tok.split('/')[0], tok.split('/').pop()]) {
      const s = seg.split('.')[0];
      if (s.length >= 4) out.add(s);
    }
  }
  return out;
}

/** Directory families a section keeps whole, written `dir/*` (e.g. `styles/*`). */
export function backtickedDirs(markdown) {
  return new Set([...markdown.matchAll(/`([A-Za-z0-9_-]+)\/\*`/g)].map((m) => m[1]));
}

/** Does a case body assert anything? Helper assertions (expectX, assertX) count; rejects and toThrow do too. */
export function hasAssertion(body) {
  return /\b(?:expect|assert|should)\w*[.(]|\.(?:toBe|toEqual|toThrow|rejects|resolves)\b|\bfail\(|\bt\.|\bok\(/.test(
    body
  );
}

/** True for a subject that says a fix, a regression or a revert (a heuristic over a conventional-commit subject). */
export function looksLikeFix(subject) {
  return (
    /^(?:fix|revert)(?:\(|:|!)/i.test(subject) ||
    /\b(flak\w*|regress\w*|revert|broke\w*|failing|red\b)/i.test(subject)
  );
}

/** Test-file paths named by a failing line of a CI log. */
export function failedPathsInLog(log) {
  const out = new Set();
  for (const line of log.split('\n')) {
    if (!/\b(FAIL|failed|Failed|FAILED)\b|[✕×❯]|✗/.test(line)) continue;
    for (const m of line.matchAll(/((?:[\w.@$-]+\/)*[\w.-]+\.(?:test|spec)\.(?:ts|mjs|js|sh))/g))
      out.add(m[1]);
  }
  return [...out];
}

/**
 * A case whose every assertion is `expect(<a name or a property path>).<matcher>(<a literal>)` and
 * which calls nothing else: a change detector for a constant, not a behaviour.
 */
export function isConstantMirror(body) {
  const lines = body
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && l !== '});' && l !== '})' && l !== '}');
  if (lines.length === 0 || lines.length > 4) return false;
  return lines.every((l) =>
    /^expect\([A-Za-z_$][\w$.]*\)\.(?:toBe|toEqual|toStrictEqual)\((?:'[^']*'|"[^"]*"|`[^`$]*`|-?[\d.]+|true|false|null|undefined|\[[^\]()]*\]|\{[^{}()]*\})\);?$/.test(
      l
    )
  );
}

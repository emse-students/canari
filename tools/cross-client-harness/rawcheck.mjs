#!/usr/bin/env node
/**
 * A BACKSLASH IN A PAGE-SIDE TEMPLATE BELONGS TO NODE, NEVER TO THE PAGE.
 *
 * Every expression this rig evaluates in a browser is built as a template literal, and Node reads
 * its escapes before CDP ever sees the string. `\r` leaves as a carriage return, `\s` leaves as the
 * letter `s`. Inside a regex literal that is the difference between a check and a decoration, and
 * only one of the two failure modes is audible:
 *
 * - `/[\r\n]+/` becomes a regex literal cut in half by a real newline. The page answers
 *   `SyntaxError: Invalid regular expression: missing /`, and `evaluate` throws. LOUD.
 * - `/\s+/` becomes `/s+/`, a perfectly valid regex that matches the letter `s`. SILENT, and it
 *   reports a normal-looking value for years.
 *
 * Both shipped. `chat.mjs`'s `HEADER_NAME` threw on every call - written doubled, halved by
 * `614bddbd`, which rewrote the lines around it rather than that one - and
 * `comm8.mjs` built ``new RegExp(`\[GRAINE\] seed \S+ ...`)``, whose pattern reached `RegExp` as
 * `[GRAINE] seed S+ ...` - `[GRAINE]` a character class, `\S` the letter `S`. That assertion could
 * not say yes, and said no under a recorded verdict.
 *
 * `String.raw` is the fix and the rule: it forwards the literal parts verbatim and interpolates
 * `${...}` exactly as before, so the shape is immune by construction rather than by vigilance. This
 * check is what keeps it that way - it exits non-zero, and it was validated as a negative control
 * against the four sites above before its clean verdict was believed.
 *
 * Usage: `node rawcheck.mjs [files...]` - every `.mjs` beside it when given none.
 */
import { readdirSync, readFileSync } from 'node:fs';

const BS = String.fromCharCode(92);

/** `\n` and `\t` are a deliberate newline in console output, and they are never a page-side pattern. */
const BENIGN_ESCAPES = 'nt';

/**
 * A template whose TEXT is executable somewhere other than here: a page-side expression, or a
 * pattern going straight into `RegExp`.
 *
 * Narrow on purpose. Every template in this rig carries backslashes somewhere - a JSDoc code span,
 * a `${...}` holding real code, a `\n` in a console banner - and a check that reports those is a
 * check whose reader learns to skip it. These two shapes are the only ones where an eaten escape
 * changes what runs, and all four mangled sites found on 2026-08-20 are of them.
 */
const SENT_ELSEWHERE = (line) => /\(function\s*\(/.test(line) || /document\./.test(line) || /RegExp\s*\(\s*`/.test(line);

/** A JSDoc or `//` line. Backticks there are prose about code, not code. */
const IS_COMMENT = (line) => /^\s*(\*|\/\/|\/\*)/.test(line);

/**
 * The line with every `${...}` blanked out.
 *
 * A substitution is real code evaluated HERE, so its backslashes are already the ones its author
 * meant - `phone.mjs` builds `` `\\d+:${PKG.replace(/\./g, '\\.')}/` ``, correct on both sides, and
 * reporting the inner `\.` would be exactly the noise that gets a check ignored. Blanked rather than
 * removed so the reported column still lines up with the file.
 */
function withoutSubstitutions(line) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const opens = line[i] === '$' && line[i + 1] === '{';
    if (opens) depth++;
    if (depth > 0) {
      if (line[i] === '}') depth--;
      out += ' ';
      continue;
    }
    out += line[i];
  }
  return out;
}

/**
 * Every escape sitting in the TEXT of a non-raw template that is sent elsewhere to be executed.
 *
 * Line-based on purpose: a JS parser would be the exact instrument and this rig has none. The
 * approximation is bounded in the honest direction - a template opening and closing on one line is
 * seen, and what it can miss is a page-side template whose opening line names neither `function` nor
 * `document`, which is a shape no check here writes.
 */
export function suspects(src) {
  const out = [];
  let inTemplate = false;
  let openedRaw = false;
  let openedSent = false;

  src.split('\n').forEach((source, i) => {
    const line = withoutSubstitutions(source);
    const ticks = line.split('`').length - 1;
    const opensHere = !inTemplate && ticks > 0;
    // `String.raw` immediately in front of the first backtick on the line that opens the template.
    const rawHere = /String\.raw\s*`/.test(line);
    const raw = inTemplate ? openedRaw : rawHere;
    const sent = inTemplate ? openedSent : SENT_ELSEWHERE(line);

    if ((inTemplate || opensHere) && !raw && sent && !IS_COMMENT(line)) {
      for (let c = 0; c < line.length; c++) {
        if (line[c] !== BS) continue;
        if (line[c + 1] === BS) { c++; continue; }
        const escape = line[c + 1];
        if (escape === undefined || BENIGN_ESCAPES.includes(escape)) continue;
        out.push({ line: i + 1, escape: BS + escape, text: source.trim().slice(0, 120) });
        break;
      }
    }

    if (ticks % 2 === 1 && !IS_COMMENT(line)) {
      inTemplate = !inTemplate;
      if (inTemplate) {
        openedRaw = rawHere;
        openedSent = SENT_ELSEWHERE(line);
      }
    }
  });

  return out;
}

const basename = (p) => p.split(BS).pop().split('/').pop();

if (import.meta.url.endsWith(basename(process.argv[1]))) {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync('.').filter((f) => f.endsWith('.mjs'));

  let hits = 0;
  for (const f of files) {
    for (const s of suspects(readFileSync(f, 'utf8'))) {
      hits++;
      console.log(`${f}:${s.line}  ${s.escape} in a template that is not String.raw`);
      console.log(`    ${s.text}`);
    }
  }

  console.log(
    hits
      ? `\n${hits} template(s) whose escapes Node eats before the page sees them - prefix with String.raw`
      : `clean - ${files.length} file(s), every page-side pattern keeps its backslashes`
  );
  process.exit(hits ? 1 : 0);
}

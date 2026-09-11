/**
 * ONE READER FOR EVERY GATE THAT MEASURES THE SOURCE ITSELF.
 *
 * `utilityScale`, `layerLadder` and `iconButtonScale` all ask the same question of the tree - "what
 * does every `.svelte` file actually declare" - and each carried its own copy of the walk and its
 * own copy of the comment stripper. Three verbatim copies is the duplication this repository
 * forbids, and it had already cost something: each copy stripped comments with
 * `source.replace(/<!--[\s\S]*?-->/g, '')`, which CodeQL flags as
 * `js/incomplete-multi-character-sanitization`, so ONE idiom produced THREE open high alerts on
 * 2026-09-09 and 2026-09-10.
 *
 * **THAT COUNT WAS THE ALERT'S SAMPLE, NOT THE POPULATION, AND THIS MODULE BELIEVED IT.** The sweep
 * repaired the three files CodeQL had named and left two more carrying the same idiom unflagged;
 * #504 then added a sixth and a SEVENTH on 2026-09-10 and reopened the identical alert against the
 * module written
 * to prevent it. Nothing was asserting the rule this docblock states, so it decayed from the day it
 * landed. `markupSources.test.ts` asserts it now, over the whole tree and in terms of the property
 * rather than the spelling - which is what found the two the first sweep had missed.
 *
 * THE ALERT IS A FALSE POSITIVE AND THE REASON IS WORTH WRITING DOWN, because the obvious repair
 * is also wrong. The rule's usual remedy is to strip repeatedly until the string stops changing,
 * on the theory that removing an inner pair splices a new one out of its neighbours. **HTML
 * comments do not nest.** `<!-- a <!-- b --> c -->` ends at the FIRST `-->`; the trailing `c -->`
 * is content, and a loop that went back for it would delete markup the file really has. A
 * fixed-point loop here changes nothing on this pattern and merely looks like diligence.
 *
 * So the stripper SCANS instead. It is the same semantics the regex had, written so that what it
 * does is visible rather than inferred from a quantifier - which is the honest answer to a rule
 * that cannot tell a lazy regex from a greedy one.
 *
 * Test-only, deliberately: no runtime code reads its own source tree.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Every `.svelte` file under `dir`, recursively. */
export function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, out);
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out;
}

/**
 * Cut every `open ... close` region out of `source`, first-close-wins.
 *
 * An unterminated opener is NOT a comment and is left where it is: a file ending mid-comment is a
 * syntax error the gate should report on, not a reason to swallow the rest of the file.
 */
function stripRegions(source: string, open: string, close: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = source.indexOf(open, at);
    if (start === -1) break;
    const end = source.indexOf(close, start + open.length);
    if (end === -1) break;
    out += source.slice(at, start);
    at = end + close.length;
  }
  return out + source.slice(at);
}

/**
 * A file's source with its comments gone, both kinds: `<!-- -->` in markup and the block form in a
 * script.
 *
 * A RULE ABOUT WHAT THE MARKUP DECLARES MUST NOT BE TRIPPED BY THE DOCBLOCK EXPLAINING THE RULE.
 * The layer ladder is discussed in several of them - `+layout.svelte` explains which rung its
 * banner column takes - and a test that failed on the explanation would punish documenting the
 * rule. The icon-button gate learned the same thing the hard way: it counted the `2.25rem` quoted
 * in a comment ABOUT the width that had been removed, and reported a fifth size that did not exist.
 */
export function withoutComments(source: string): string {
  return stripRegions(stripRegions(source, '<!--', '-->'), '/*', '*/');
}

/** One entry per `.svelte` file under `lib` and `routes`, comment-free, path relative to `src`. */
export function allMarkup(src: string): { file: string; body: string }[] {
  return svelteFiles(join(src, 'lib'))
    .concat(svelteFiles(join(src, 'routes')))
    .map((file) => ({
      file: relative(src, file),
      body: withoutComments(readFileSync(file, 'utf8')),
    }));
}

/**
 * `source` with its LINE comments gone too, on top of what `withoutComments` removes.
 *
 * A gate that reads a file's CODE and forbids an idiom must not be tripped by a `//` remark about
 * that very idiom - which is how the rule ends up impossible to document beside the code it
 * governs. `withoutComments` is left alone because the markup gates do not need this pass: a
 * `.svelte` file's `//` lives inside a `<script>` they already read through the block stripper.
 *
 * Scanned rather than matched, for the same reason the whole module is: a `//` inside a URL is not
 * a comment, and a regex saying so (`(^|[^:])//`) states the exception instead of the rule, so it
 * reads past `"a" + "//x"` and anything else that reaches `//` without a colon in front.
 */
export function withoutAnyComments(source: string): string {
  return withoutComments(source)
    .split('\n')
    .map((line) => {
      // A `//` is a comment unless it is inside a string or a URL scheme. Both exceptions are
      // decided by what PRECEDES it on the line, which is why this walks rather than matches.
      let quote = '';
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i += 1;
          else if (c === quote) quote = '';
        } else if (c === '"' || c === "'" || c === '`') {
          quote = c;
        } else if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

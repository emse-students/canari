#!/usr/bin/env node
/**
 * Every intra-repository markdown link resolves - the file exists, it is INSIDE this repository,
 * and so does the anchor.
 *
 * **IT CHECKED ONLY `*.md#anchor` UNTIL 2026-09-24, WHICH IS HOW THE THING IT EXISTS TO CATCH GOT
 * PAST IT.** A link to a source file, to a script, or to a page with no fragment was not looked at
 * at all - so `nestjs-framework.md` pointed at `.github/scripts/dependabot-auto-merge.sh` for
 * twenty days after that script was deleted, and a sweep by hand found it, which is exactly the
 * outcome the paragraph below calls unacceptable. Widening it to EVERY relative link cost nothing:
 * 2150 links, of which ten were dead - a 380-line production runbook and a 512-line campaign
 * archive, each deleted as collateral in an unrelated pull request and each still cited as live by
 * pages that had no way to know. A fragment is still checked when the target is markdown and still
 * ignored when it is not, because `#L42` on a source file is GitHub's line anchor, not a heading.
 *
 * A target OUTSIDE the repository fails even when it resolves, because the sibling repositories
 * exist on a developer's disk and on no runner: a link to `../le-cercle/README.md` would pass
 * every local run and be dead for every reader.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. `docs/wiki/` is the repository's memory, and CLAUDE.md
 * makes it the thing to read BEFORE the source. A link into it is how one page hands a reader to
 * the paragraph that carries the reasoning - and renaming a heading breaks every such link
 * SILENTLY. GitHub does not 404 a dead fragment: it serves the page, scrolled to the top, and the
 * reader lands on a 900-line file with no idea which section was meant. Nothing else in this
 * repository would ever notice. It was found by hand on 2026-09-03, after a heading rename in
 * `cicd.md` orphaned the link that pointed at it, and the same sweep found a second one that had
 * been dead for far longer.
 *
 * The slug is GitHub's, and getting it wrong is how a checker like this ends up disbelieved:
 * markdown links render as their LABEL, backticks and punctuation vanish, letters lowercase,
 * digits, spaces, `-` and `_` survive, and each remaining SPACE becomes one `-`. So
 * `## Shared gotchas -> [development](development.md), [cicd](cicd.md)` is
 * `#shared-gotchas---development-cicd`, three hyphens and all - collapsing runs of whitespace, or
 * dropping the underscore in `dm_groups`, reports a dozen live links as dead and the next reader
 * deletes the test rather than the links.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const SKIP = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.svelte-kit', 'gen']);

/** Collects every markdown file under `dir`, skipping generated and vendored trees. */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** GitHub's heading slug. See the header comment - every clause here was a false positive first. */
function slug(heading) {
  return heading
    .trim()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replaceAll(' ', '-');
}

/** The anchors a file offers, with GitHub's `-1`, `-2`... suffixes for repeated headings. */
function anchorsOf(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const [, heading] of text.matchAll(/^#{1,6} +(.*)$/gm)) {
    const base = slug(heading);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

const files = collect(ROOT);
const anchors = new Map(files.map((f) => [normalize(f), anchorsOf(readFileSync(f, 'utf-8'))]));
const broken = [];

for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  const where = relative(ROOT, file).split(sep).join('/');
  for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    // A scheme (`https:`, `mailto:`), a protocol-relative host or a bare fragment is somebody
    // else's to resolve. Everything left is a path into this repository.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link)) continue;
    const [rel, fragment] = link.split('#');
    if (!rel) continue;
    const target = normalize(resolve(dirname(file), rel));
    const inside = relative(ROOT, target);
    if (inside === '' || inside.startsWith('..')) {
      broken.push(`${where} -> ${link} (outside the repository - dead for every reader but you)`);
      continue;
    }
    if (!existsSync(target)) {
      broken.push(`${where} -> ${link} (no such file)`);
      continue;
    }
    // A fragment is an anchor only on markdown; `#L42` on a source file is GitHub's line number.
    if (!fragment || !anchors.has(target)) continue;
    if (!anchors.get(target).has(fragment)) broken.push(`${where} -> ${link} (no such anchor)`);
  }
}

if (broken.length > 0) {
  console.error(`FAIL: ${broken.length} markdown link(s) resolve to nothing:\n`);
  for (const line of broken) console.error(`  ${line}`);
  console.error('\nA renamed heading breaks every link into it, and GitHub reports nothing.');
  process.exit(1);
}

console.log(`OK: every intra-repository markdown link in ${files.length} files resolves.`);

#!/usr/bin/env bun
/**
 * ONE ANALYSIS DEFINITION, ONE CODEQL IDENTITY.
 *
 * CodeQL names a configuration after the workflow that CALLED it. `code-analysis.yml` is a
 * `workflow_call` library invoked from `ci.yml` and from `scheduled.yml`, so without an explicit
 * category ONE definition uploaded under TWO names:
 *
 *     .github/workflows/ci.yml:codeql/language:javascript-typescript
 *     .github/workflows/scheduled.yml:codeql/language:javascript-typescript
 *
 * GitHub Advanced Security then expects both on every ref - and a pull request can never carry
 * the second, because `scheduled.yml` is a cron and does not run on a branch. The `CodeQL` check
 * therefore reported `configurations not found` and went red on EVERY pull request from the
 * 2026-09-02 workflow migration onwards.
 *
 * IT MERGED ANYWAY, WHICH IS THE WORSE HALF. That check is advisory - `CI passed` is the one the
 * ruleset requires - so a permanent red cross became something a reader learns to skip, and on
 * #482 it hid a real high-severity alert inside a summary nobody had a reason to open. A red tick
 * nothing enforces is worse than no tick.
 *
 * The claim here is the narrowest one that would have caught it: an `analyze` step must say who it
 * is. It does NOT check the category's value - that is a design choice - only that the identity
 * comes from the definition rather than from whoever happened to call it.
 *
 * Usage: bun .github/scripts/tests/codeql-category.test.mjs   (no arguments, no network)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workflows = resolve(here, '../../workflows');

/**
 * Every `github/codeql-action/analyze` step, with the block of lines belonging to it.
 *
 * A step ends at the next line indented no deeper than its own `- name:`/`- uses:`, which is how
 * YAML says so without parsing YAML - and parsing it would mean a dependency for one question.
 */
function analyzeSteps(source) {
  const lines = source.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*uses:\s*github\/codeql-action\/analyze@/.test(lines[i])) continue;
    // Walk back to the `-` that opens this step, then forward to the next one.
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;
    const indent = lines[start].search(/\S/);
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() !== '' && line.search(/\S/) <= indent) break;
      end++;
    }
    found.push({ line: start + 1, body: lines.slice(start, end).join('\n') });
  }
  return found;
}

const files = readdirSync(workflows).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
let steps = 0;
const anonymous = [];

for (const file of files) {
  for (const step of analyzeSteps(readFileSync(resolve(workflows, file), 'utf8'))) {
    steps++;
    if (!/^\s*category:\s*\S/m.test(step.body)) {
      anonymous.push(`.github/workflows/${file}:${step.line}`);
    }
  }
}

if (steps === 0) {
  console.error(
    'FAIL: no `github/codeql-action/analyze` step found in .github/workflows/.\n' +
      'Either CodeQL was removed - in which case delete this test and say so - or the reader is\n' +
      'wrong, which is the same failure it exists to prevent: a check that matches nothing passes.'
  );
  process.exit(1);
}

if (anonymous.length > 0) {
  console.error(`FAIL: ${anonymous.length} CodeQL analyze step(s) with no explicit category:\n`);
  for (const s of anonymous) console.error(`  ${s}`);
  console.error(
    '\nWithout `category:`, CodeQL names the configuration after the workflow that CALLED it. A\n' +
      '`workflow_call` library called from two places then uploads under two names, GitHub expects\n' +
      'both on every ref, and the one belonging to a cron can never appear on a pull request - so\n' +
      'the CodeQL check goes red on every one of them. Add `category: "/language:<lang>"`.'
  );
  process.exit(1);
}

console.log(`ok   all ${steps} CodeQL analyze step(s) declare their own category`);

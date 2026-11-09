#!/usr/bin/env bun
/**
 * THE RAW-CONTROLS RATCHET MAY ONLY GO DOWN - compared with the base, which no vitest file can do.
 *
 * WHY. `frontend/src/lib/styles/controlsGuard.test.ts` refuses a screen that exceeds
 * `rawControlsRatchet.json`, but the JSON is itself part of the diff: a hand edit that raises a
 * number or adds a file passes it. Only a comparison with the commit the change is built on can
 * tell, and a vitest run has no base. This script is that comparison.
 *
 * USAGE. `bun .github/scripts/ratchet-not-raised.mjs [<base-ref>]`. The default base is
 * `git merge-base HEAD origin/main`; CI passes `HEAD^1` (the base of the synthesised merge commit of
 * a pull request, the previous main for a push). A base without the file (the change that
 * introduces it) passes. Exit 1 names every violation.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RATCHET_REL = 'frontend/src/lib/styles/rawControlsRatchet.json';

/**
 * Every way `head` raises the ratchet over `base`: an entry that is new, or a count that is higher.
 * Lower counts and removed entries are progress and pass.
 *
 * @param {Record<string, Record<string, number>>} base the ratchet on the base commit
 * @param {Record<string, Record<string, number>>} head the ratchet being proposed
 * @returns {string[]} one human-readable line per violation
 */
export function ratchetRaises(base, head) {
  const out = [];
  for (const [file, counts] of Object.entries(head)) {
    const was = base[file];
    if (!was) {
      out.push(`${file}: new entry in the ratchet (a file not listed can never gain a raw control)`);
      continue;
    }
    for (const [kind, n] of Object.entries(counts)) {
      const before = was[kind] ?? 0;
      if (n > before) out.push(`${file}: ${kind} raised ${before} -> ${n}`);
    }
  }
  return out;
}

function main() {
  const root = resolve(import.meta.dirname, '..', '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const baseRef = process.argv[2] ?? git('merge-base', 'HEAD', 'origin/main');
  let baseText;
  try {
    baseText = git('show', `${baseRef}:${RATCHET_REL}`);
  } catch {
    console.log(`ratchet-not-raised: ${RATCHET_REL} absent on ${baseRef}; nothing to compare.`);
    return;
  }
  const head = JSON.parse(readFileSync(join(root, RATCHET_REL), 'utf8'));
  const raises = ratchetRaises(JSON.parse(baseText), head);
  if (raises.length === 0) {
    console.log(`ratchet-not-raised: OK against ${baseRef}.`);
    return;
  }
  console.error(`ratchet-not-raised: the ratchet was RAISED against ${baseRef}:`);
  for (const line of raises) console.error(`  ${line}`);
  process.exit(1);
}

if (import.meta.main) main();

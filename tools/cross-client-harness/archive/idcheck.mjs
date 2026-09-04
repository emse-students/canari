#!/usr/bin/env node
/**
 * Does anything STAGED carry a real identity? Run it before every commit that touches this rig.
 *
 *   bun idcheck.mjs            the staged index (what a commit would publish)
 *   bun idcheck.mjs --tree     every tracked file, for an audit
 *
 * WHY IT EXISTS. `emse-students/canari` is public, the campaign runs against production with two
 * real accounts, and "no check spells a name" is a rule that nothing enforces - no compiler types a
 * string as an identity. It was believed to hold and did not: a sweep on 2026-08-15 found twelve
 * sites in nine files, including two real logins in a header comment, a first name as a `--who`
 * DEFAULT, and a real group id quoted in a log sample. The peer's display name had already reached
 * the public archive once, at `95d76fdf`, the same way.
 *
 * IT SEARCHES THE INDEX, NOT THE WORKING COPY. An earlier version compared "working-copy files that
 * contain an identity" against "files of that name tracked in git", which says nothing at all about
 * tracked CONTENT and would have passed a leak while reporting success.
 *
 * MATCHING IS WORD-BOUNDED, and the needles are built to avoid the two failure modes that make a
 * checker useless. Too loose and it drowns: unbounded substring matching found a first name inside
 * an ordinary French adverb in the message catalogue, and flagged the author's own name in `LICENSE`
 * and `Cargo.toml`, where it legitimately belongs. Too tight and it misses: a surname on its own is
 * still an identity, so full strings AND their individual words are both searched.
 *
 * WHAT IS NOT A NEEDLE MATTERS AS MUCH. `W1` / `W2` / `A1` ARE the anonymisation - they are what the
 * wiki uses INSTEAD of a name - so feeding the account file's `clients` labels in as identities made
 * the checker report 66 "leaks" that were the convention working exactly as intended. A checker that
 * cries wolf is one nobody reads, and it would have buried the two real hits on this same run.
 *
 * It never prints the term it searched for - only the kind, the count and the location - so running
 * it does not itself put a name into a transcript or a CI log.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../names.mjs';
import * as names from '../names.mjs';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tree = process.argv.includes('--tree');

/** Only what this rig and its documentation contain; the rest of the tree is not what is reviewed. */
const SCOPE = ['tools/cross-client-harness', 'docs', 'CLAUDE.md', 'README.md', 'CHANGELOG.md'];

const accounts = JSON.parse(readFileSync(join(STATE_DIR, 'test-accounts.json'), 'utf8')).accounts;

/** Full strings first, then their individual words - a surname alone is still an identity. */
const needles = [];
const add = (kind, v) => {
  const s = String(v ?? '').trim();
  if (s.length >= 4) needles.push([kind, s]);
  for (const part of s.split(/[\s@]+/)) if (part.length >= 4 && part !== s) needles.push([kind, part]);
};
add('owner display name', names.OWNER_NAME);
add('peer display name', names.PEER_NAME);
// The IP only. Splitting `1.2.3.4:5555` on the colon would make the PORT a needle, and a four-digit
// port matches half the tree - three false positives that hid nothing but cost a review pass.
add('phone ip', String(names.A1_WIFI ?? '').split(':')[0]);
for (const k of Object.values(names.ACCOUNT_OF ?? {})) add('account key', k);
for (const a of Object.values(accounts)) {
  add('login', a.username);
  add('password', a.password);
  add('pin', a.pin);
}

let hits = 0;
const seen = new Set();
for (const [kind, term] of needles) {
  if (seen.has(term)) continue;
  seen.add(term);
  const args = ['grep', '-i', '-w', '-n', '-F'];
  if (!tree) args.push('--cached');
  let out = '';
  try {
    out = execFileSync('git', [...args, '-e', term, '--', ...SCOPE], { cwd: REPO, encoding: 'utf8' });
  } catch {
    continue; // git grep exits 1 on no match, which is the answer this wants
  }
  const lines = out.split('\n').filter(Boolean);
  hits += lines.length;
  console.log(`LEAK (${kind}) - ${lines.length} line(s):`);
  for (const l of lines) console.log(`    ${l.split(':').slice(0, 2).join(':')}`);
}

console.log(
  hits === 0
    ? `clean - ${seen.size} identity strings, 0 hits in ${tree ? 'the tracked tree' : 'the staged index'}`
    : `${hits} HIT(S) - fix them before committing; import from names.mjs rather than spelling`
);
process.exit(hits === 0 ? 0 : 1);

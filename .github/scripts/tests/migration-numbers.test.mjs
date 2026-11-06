#!/usr/bin/env bun
/**
 * IS EVERY MIGRATION NUMBER OF A SERVICE TAKEN ONCE?
 *
 * Two pull requests written in parallel each took the next free number: #3061 added
 * `134_deleted_post_ids.sql` while the held #3024 carried `134_drop_posts_pinned.sql` (review of
 * #3061, 2026-11-06). Nothing said so - each branch was alone with its number, and the files differ
 * by name, so git merges both without a conflict. The order two migrations of one number run in is
 * then the alphabet's, which nobody chose.
 *
 * THE DUPLICATES ALREADY SHIPPED ARE LISTED BY NAME, and only those: they ran on every estate long
 * ago, and renaming one would make the deploy apply it a second time. A new duplicate fails here,
 * on the second branch's own CI once it is brought up to date with the first.
 *
 * Usage: bun .github/scripts/tests/migration-numbers.test.mjs   (no arguments, no network)
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Numbers that shipped twice before this test existed, per service: `service/number`. */
const SHIPPED_DUPLICATES = new Set(['social-service/037']);

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass++;
  console.log(`  ok   ${m}`);
};
const bad = (m) => {
  fail++;
  console.log(`  FAIL ${m}`);
};

const services = readdirSync(join(repoRoot, 'apps')).filter((name) =>
  existsSync(join(repoRoot, 'apps', name, 'src', 'migrations'))
);
if (services.length === 0) bad('no service has a src/migrations directory - nothing was checked');

for (const service of services) {
  const files = readdirSync(join(repoRoot, 'apps', service, 'src', 'migrations')).filter((f) =>
    /^\d+_.*\.sql$/.test(f)
  );
  const byNumber = new Map();
  for (const file of files) {
    const number = file.split('_')[0];
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }
  const twice = [...byNumber].filter(([, names]) => names.length > 1);
  const fresh = twice.filter(([n]) => !SHIPPED_DUPLICATES.has(`${service}/${n}`));
  if (fresh.length === 0) {
    ok(`${service}: ${files.length} migrations, no number taken twice beyond the shipped ones`);
  } else {
    for (const [n, names] of fresh) {
      bad(`${service}: number ${n} is taken by ${names.join(' and ')} - renumber the newer one`);
    }
  }
  // A listed duplicate that is no longer one is a stale entry: the list must shrink with the fact.
  for (const key of SHIPPED_DUPLICATES) {
    const [svc, n] = key.split('/');
    if (svc === service && (byNumber.get(n)?.length ?? 0) < 2) {
      bad(`${key} is listed as a shipped duplicate but is not one - delete the entry`);
    }
  }
}

console.log(`migration-numbers: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

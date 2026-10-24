#!/usr/bin/env bun
/**
 * THE IMAGE SCAN'S ALLOWLIST IS A LIST OF REASONS, AND EVERY ONE OF THEM IS READ BY ITS RETIREMENT.
 *
 * `.github/image-scan-allowlist.yaml` suppresses advisories in `image-scan.sh`. Three things make an
 * entry legitimate, and each is asserted here with no network:
 *
 *   1. it names ONE advisory, by an id Trivy reports (`CVE-...` or `GHSA-...`);
 *   2. it carries a `statement` - why the advisory does not reach us, or why its fix is not ours to
 *      ship - because an ignore without a reason is a hole with nothing over it;
 *   3. it has NO `expired_at`. Trivy would happily drop an entry on a date, and the date would say
 *      nothing about the image: retirement is by EVIDENCE (`image-scan.sh` rescans without this file
 *      and fails on an id nothing reports), never by a clock.
 *
 * And the reader that retirement check uses (`image-scan.sh --allowlist-ids`, a grep) must see
 * exactly the entries a real YAML parse sees: an entry it missed would never be retired. The same
 * holds for `--allowlist-purls`, which retires a purl-scoped entry on its own package.
 *
 * Usage: bun .github/scripts/tests/image-scan-allowlist.test.mjs   (no arguments, no network)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '../../image-scan-allowlist.yaml');
const scanScript = resolve(here, '../image-scan.sh');

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures++;
};

const doc = Bun.YAML.parse(readFileSync(file, 'utf8'));
const entries = doc?.vulnerabilities;
if (!Array.isArray(entries)) {
  console.error(`FAIL ${file} has no \`vulnerabilities:\` list, so Trivy would apply nothing and this test would check nothing.`);
  process.exit(1);
}

const allowedKeys = new Set(['id', 'paths', 'purls', 'statement']);
const seen = new Set();
console.log(`every one of the ${entries.length} allowlist entries is legitimate:`);
for (const [i, e] of entries.entries()) {
  const where = `entry ${i + 1} (${e?.id ?? 'no id'})`;
  if (typeof e?.id !== 'string' || !/^(CVE-\d{4}-\d+|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/.test(e.id)) {
    fail(`${where}: the id is not one advisory Trivy reports (CVE-YYYY-N or GHSA-xxxx-xxxx-xxxx)`);
  }
  if (typeof e?.statement !== 'string' || e.statement.trim().length < 30) {
    fail(`${where}: no statement, or one too short to say why - an ignore must carry its reason`);
  }
  if (e && 'expired_at' in e) {
    fail(`${where}: has expired_at - an entry retires when the rescan stops reporting it, never on a date`);
  }
  for (const key of Object.keys(e ?? {})) {
    if (!allowedKeys.has(key)) fail(`${where}: unknown key \`${key}\` (Trivy would ignore it silently)`);
  }
  const identity = `${e?.id}|${JSON.stringify(e?.paths ?? [])}|${JSON.stringify(e?.purls ?? [])}`;
  if (seen.has(identity)) fail(`${where}: listed twice`);
  seen.add(identity);
}

console.log('the retirement check reads every entry:');
const parsed = [...new Set(entries.map((e) => e?.id))].sort();
const run = Bun.spawnSync(['bash', scanScript, '--allowlist-ids']);
if (run.exitCode !== 0) {
  fail(`image-scan.sh --allowlist-ids exited ${run.exitCode}: ${run.stderr.toString().trim()}`);
} else {
  const read = run.stdout.toString().split('\n').filter(Boolean).sort();
  const missed = parsed.filter((id) => !read.includes(id));
  const invented = read.filter((id) => !parsed.includes(id));
  if (missed.length) fail(`image-scan.sh does not read ${missed.join(', ')}, so nothing would ever retire them`);
  if (invented.length) fail(`image-scan.sh reads ${invented.join(', ')}, which no entry names`);
  if (!missed.length && !invented.length) console.log(`  ok   image-scan.sh reads the same ${read.length} ids a YAML parse does`);
}

// The purl half of the retirement check: one advisory allowlisted on two packages stays reported by
// id while either remains, so each purl is retired on its own `id package version` triple.
console.log('the retirement check reads every purl-scoped entry on its package:');
const triples = [
  ...new Set(
    entries.flatMap((e) =>
      (e?.purls ?? []).map((p) => {
        const nameVersion = String(p).split('?')[0].split('/').pop();
        const at = nameVersion.indexOf('@');
        if (at < 1) fail(`${e?.id}: purl ${p} names no version, so it would cover every build of the package`);
        return `${e?.id} ${nameVersion.slice(0, at)} ${decodeURIComponent(nameVersion.slice(at + 1))}`;
      }),
    ),
  ),
].sort();
const purlRun = Bun.spawnSync(['bash', scanScript, '--allowlist-purls']);
if (purlRun.exitCode !== 0) {
  fail(`image-scan.sh --allowlist-purls exited ${purlRun.exitCode}: ${purlRun.stderr.toString().trim()}`);
} else {
  const read = purlRun.stdout.toString().split('\n').filter(Boolean).sort();
  const missed = triples.filter((t) => !read.includes(t));
  const invented = read.filter((t) => !triples.includes(t));
  if (missed.length) fail(`image-scan.sh does not read ${missed.join(', ')}, so that purl would never retire`);
  if (invented.length) fail(`image-scan.sh reads ${invented.join(', ')}, which no entry names`);
  if (!missed.length && !invented.length) console.log(`  ok   image-scan.sh reads the same ${read.length} purls a YAML parse does`);
}

if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('  ok   every entry names one advisory, says why, and carries no date');

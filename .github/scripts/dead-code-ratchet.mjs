#!/usr/bin/env bun
/**
 * THE DEAD-CODE RATCHET: the count of unused things in `frontend/` may only go down.
 *
 * WHY (owner, 2026-11-07: "dead code is deleted"). A sweep that is not asserted comes back: an
 * export written for a call site that never arrived, a file orphaned by a refactor, a translation
 * key whose screen was deleted. Two measurements, both deterministic, both run here:
 *
 *   - `knip` (config: `frontend/knip.json`): unused files, exports, exported types, duplicate
 *     exports, dependencies and unresolved imports;
 *   - the unused translation keys: a key of `messages/fr.json` whose name appears as an identifier
 *     or inside a string in NO source file (`m.key()`, `{ key }`, `m['key']`, `{ labelKey: 'key' }`
 *     all name it). Nothing builds a key from a variable, so a name that appears nowhere is dead;
 *     a key that is genuinely reached some other way goes in `frontend/dead-code-allowlist.json`
 *     WITH A REASON.
 *
 * THE BASELINE IS `frontend/dead-code-baseline.json`, and the comparison is EXACT: more than the
 * baseline fails (a new unused export), fewer than the baseline also fails until the baseline is
 * lowered with `--update`, so a gain is locked the day it is made. `--update` refuses to RAISE any
 * number. Why it is a count and not a list: two pull requests that each delete something conflict
 * on a list and never on a number they can both lower.
 *
 *   bun .github/scripts/dead-code-ratchet.mjs frontend            # the gate
 *   bun .github/scripts/dead-code-ratchet.mjs frontend --update   # lock a gain in
 *
 * Mechanism and how to allow-list: docs/wiki/dead-code.md.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The knip issue categories the ratchet counts (every array knip's JSON reporter fills). */
export const KNIP_CATEGORIES = [
  'files',
  'exports',
  'types',
  'duplicates',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'enumMembers',
  'namespaceMembers',
];

const SOURCE_FILE = /\.(ts|js|mjs|svelte)$/;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Counts and names the items of a knip JSON report, per category.
 *
 * @param {{ issues: Array<Record<string, unknown>> }} report parsed `knip --reporter json`
 * @returns {{ counts: Record<string, number>, items: Record<string, string[]> }}
 */
export function summariseKnip(report) {
  const counts = Object.fromEntries(KNIP_CATEGORIES.map((c) => [c, 0]));
  const items = Object.fromEntries(KNIP_CATEGORIES.map((c) => [c, []]));
  for (const issue of report.issues) {
    for (const category of KNIP_CATEGORIES) {
      const found = issue[category];
      if (!Array.isArray(found)) continue;
      for (const entry of found) {
        counts[category] += 1;
        const name = entry && typeof entry === 'object' && 'name' in entry ? entry.name : '';
        items[category].push(`${issue.file}${name ? `: ${name}` : ''}`);
      }
    }
  }
  return { counts, items };
}

/**
 * Every identifier-shaped token of every source file under `dir`, the generated Paraglide output
 * excluded (it names every key by construction).
 *
 * @param {string} dir directory to walk
 * @returns {Set<string>}
 */
export function sourceTokens(dir) {
  const tokens = new Set();
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (entry === 'paraglide' || entry === 'node_modules') continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (SOURCE_FILE.test(entry)) {
        for (const token of readFileSync(path, 'utf8').match(TOKEN) ?? []) tokens.add(token);
      }
    }
  };
  walk(dir);
  return tokens;
}

/**
 * The translation keys no source file names, minus the allow-listed ones.
 *
 * @param {string[]} keys the keys of `messages/fr.json`
 * @param {Set<string>} tokens {@link sourceTokens}
 * @param {Record<string, string>} allowed key -> reason it is reached without being named
 * @returns {string[]}
 */
export function unusedMessageKeys(keys, tokens, allowed) {
  return keys.filter((key) => !tokens.has(key) && !(key in allowed));
}

/**
 * Compares a measurement with the baseline.
 *
 * @param {Record<string, number>} baseline label -> allowed count
 * @param {Record<string, number>} current label -> measured count
 * @returns {{ raised: string[], lowered: string[] }} labels above and below the baseline
 */
export function compareToBaseline(baseline, current) {
  const raised = [];
  const lowered = [];
  for (const label of Object.keys(current)) {
    const allowed = baseline[label] ?? 0;
    if (current[label] > allowed) raised.push(label);
    else if (current[label] < allowed) lowered.push(label);
  }
  return { raised, lowered };
}

/** Runs knip in `frontendDir` and returns its parsed JSON report (knip exits 1 on any finding). */
function runKnip(frontendDir) {
  const run = Bun.spawnSync(
    [process.execPath, 'x', 'knip', '--no-progress', '--reporter', 'json'],
    { cwd: frontendDir, stdout: 'pipe', stderr: 'pipe' }
  );
  const out = run.stdout.toString();
  try {
    return JSON.parse(out);
  } catch {
    console.error(
      `knip did not produce JSON (exit ${run.exitCode}):\n${out}\n${run.stderr.toString()}`
    );
    process.exit(2);
  }
}

function main() {
  const [frontendDir, ...flags] = process.argv.slice(2);
  if (!frontendDir) {
    console.error('usage: dead-code-ratchet.mjs <frontend-dir> [--update]');
    process.exit(2);
  }
  const update = flags.includes('--update');
  const baselinePath = join(frontendDir, 'dead-code-baseline.json');
  const allowlistPath = join(frontendDir, 'dead-code-allowlist.json');

  const knip = summariseKnip(runKnip(frontendDir));
  const allowed = existsSync(allowlistPath)
    ? (JSON.parse(readFileSync(allowlistPath, 'utf8')).messages ?? {})
    : {};
  const keys = Object.keys(
    JSON.parse(readFileSync(join(frontendDir, 'messages/fr.json'), 'utf8'))
  ).filter((key) => key !== '$schema');
  const unusedKeys = unusedMessageKeys(keys, sourceTokens(join(frontendDir, 'src')), allowed);

  const current = { ...knip.counts, messages: unusedKeys.length };
  const items = { ...knip.items, messages: unusedKeys };

  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`dead-code: no baseline, wrote ${relative(process.cwd(), baselinePath)}`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const { raised, lowered } = compareToBaseline(baseline, current);

  for (const label of raised) {
    console.error(
      `dead-code: ${label} rose from ${baseline[label] ?? 0} to ${current[label]}. All of them:`
    );
    for (const item of items[label]) console.error(`  ${item}`);
  }
  if (update) {
    if (raised.length > 0) {
      console.error(
        'dead-code: --update never raises the baseline. Delete the dead code, or allow-list it with a reason (docs/wiki/dead-code.md).'
      );
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`dead-code: baseline lowered for ${lowered.join(', ') || 'nothing'}`);
    return;
  }
  if (raised.length > 0) {
    console.error(
      'dead-code: FAIL. Delete what is new, or allow-list it with a reason: docs/wiki/dead-code.md'
    );
    process.exit(1);
  }
  if (lowered.length > 0) {
    console.error(
      `dead-code: FAIL. ${lowered.map((l) => `${l} ${baseline[l]} -> ${current[l]}`).join(', ')}: lock the gain in with \`bun .github/scripts/dead-code-ratchet.mjs ${frontendDir} --update\`.`
    );
    process.exit(1);
  }
  console.log(
    `dead-code: ok, ${Object.entries(current)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`
  );
}

if (import.meta.main) main();

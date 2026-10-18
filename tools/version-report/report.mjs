#!/usr/bin/env bun
/**
 * WHICH APP VERSION DOES EACH DEVICE RUN, AND WHO IS BELOW THE FLOOR?
 *
 * Read-only. The version is `key_package.deviceAppVersion`, written on every key package publish
 * since #613 - no new column. The floor is `platform_config.min_client_version` of the SAME
 * database, so the report compares against the estate it reads, never a typed number by accident.
 *
 * LOCAL / DEV ESTATES ONLY. The container is found by compose project label and the project must
 * be on the allowlist below; production is not on it and this file offers no way to name it.
 *
 * Usage: bun tools/version-report/report.mjs [--project canari-dev] [--floor X.Y.Z] [--devices]
 *        bun tools/version-report/report.mjs --input rows.txt --floor X.Y.Z   (rows from a file)
 * Exit 0 - nobody below the floor. Exit 1 - at least one device is below it. Exit 2 - refused or
 * could not look (never a pass).
 */
import { readFileSync } from 'node:fs';
import { classify, parseRows, render } from './lib.mjs';

/** Compose projects this tool may read. Production is deliberately absent. */
const ALLOWED_PROJECTS = ['canari-dev'];
const QUERY = 'SELECT "userId", "deviceId", "deviceOs", "deviceAppVersion", "createdAt" FROM key_package ORDER BY "createdAt"';
const FLOOR_QUERY = 'SELECT min_client_version FROM platform_config WHERE id = 1';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Runs one psql statement in the estate's postgres container and returns stdout. */
function psql(container, sql) {
  const escaped = sql.replaceAll('"', '\\"');
  const r = Bun.spawnSync(['docker', 'exec', container, 'sh', '-c', `psql -At -F '|' -U "$POSTGRES_USER" -d auth_db -c "${escaped}"`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) throw new Error(`psql failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Finds the estate's postgres container, refusing any project off the allowlist. */
function findContainer(project) {
  if (!ALLOWED_PROJECTS.includes(project)) {
    console.error(`refused: project "${project}" is not on the allowlist (${ALLOWED_PROJECTS.join(', ')}); this report never reads production`);
    process.exit(2);
  }
  const r = Bun.spawnSync(
    ['docker', 'ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=postgres', '--format', '{{.Names}}'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const name = r.stdout.toString().trim();
  if (!name) {
    console.error(`no running postgres container for compose project "${project}"`);
    process.exit(2);
  }
  return name;
}

let rowsText;
let floor = opt('--floor');
const input = opt('--input');
if (input) {
  if (!floor) {
    console.error('--input needs --floor');
    process.exit(2);
  }
  rowsText = readFileSync(input, 'utf8');
} else {
  const container = findContainer(opt('--project') ?? 'canari-dev');
  rowsText = psql(container, QUERY);
  floor ??= psql(container, FLOOR_QUERY).trim();
}

const result = classify(parseRows(rowsText), floor);
console.log(render(result, args.includes('--devices')));
process.exit(result.below.length > 0 ? 1 : 0);

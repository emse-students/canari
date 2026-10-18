/**
 * Pure logic of the version report: parse the rows the SQL returns, compare each device's reported
 * version with the client floor, and group the result. No I/O here so it is testable without a
 * database; `report.mjs` owns the query.
 */

/** Same shape the server compares (`apps/core-service/src/platform/semver.ts`), pre-release suffix allowed. */
const CORE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Reads `major.minor.patch` out of a reported version. A pre-release suffix is ignored, exactly as
 * the server's floor check does (`compareSemver` parses `7-alpha.1` as 7), so this report names the
 * devices the floor would name.
 * @returns the three integers, or `null` when the string is not a version.
 */
export function parseVersion(raw) {
  const m = CORE_VERSION.exec((raw ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @returns -1, 0 or 1 like `compareSemver`; both arguments must parse. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`compareVersions: unreadable version (${a}, ${b})`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * Parses `psql -At -F '|'` output of `userId|deviceId|deviceOs|deviceAppVersion|createdAt`.
 * Empty cells become `null`. A malformed line throws, never a skipped row: a report that silently
 * drops devices under-counts exactly the population it exists to find.
 */
export function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split('|');
    if (cells.length !== 5) throw new Error(`parseRows: expected 5 cells, got ${cells.length}: ${line}`);
    const [userId, deviceId, os, version, updatedAt] = cells.map((c) => (c === '' ? null : c));
    rows.push({ userId, deviceId, os, version, updatedAt });
  }
  return rows;
}

/**
 * Classifies every device against the floor.
 *
 * - `below`: reports a readable version under the floor.
 * - `unreported`: no readable version (enrolled before #613, or never re-published). NOT counted as
 *   below: nothing says what it runs, and the floor's own rule lets it through.
 * - `current`: at or above the floor.
 *
 * `byVersion` lists every readable version with its device count, oldest first, so the
 * distribution stays visible beside the laggards.
 */
export function classify(rows, floor) {
  if (!parseVersion(floor)) throw new Error(`classify: unreadable floor "${floor}"`);
  const below = [];
  const unreported = [];
  const current = [];
  const counts = new Map();
  for (const r of rows) {
    if (!parseVersion(r.version)) {
      unreported.push(r);
      continue;
    }
    counts.set(r.version, (counts.get(r.version) ?? 0) + 1);
    (compareVersions(r.version, floor) < 0 ? below : current).push(r);
  }
  const byVersion = [...counts.entries()]
    .map(([version, devices]) => ({ version, devices }))
    .sort((a, b) => compareVersions(a.version, b.version) || a.version.localeCompare(b.version));
  return { floor, below, unreported, current, byVersion };
}

/** Groups laggards by `os version`, oldest version first. */
export function groupLaggards(below) {
  const groups = new Map();
  for (const r of below) {
    const key = JSON.stringify([r.os ?? 'unknown-os', r.version]);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()]
    .map(([key, devices]) => {
      const [os, version] = JSON.parse(key);
      return { os, version, label: `${os} ${version}`, devices };
    })
    .sort((a, b) => compareVersions(a.version, b.version) || a.os.localeCompare(b.os))
    .map(({ label, devices }) => ({ label, devices }));
}

/** Renders the report as text. `withDevices` adds one line per laggard (user and device ids). */
export function render(result, withDevices = false) {
  const { floor, below, unreported, current, byVersion } = result;
  const out = [];
  out.push(`client floor (minClientVersion): ${floor}`);
  out.push(
    `devices: ${below.length + unreported.length + current.length} (below ${below.length}, unreported ${unreported.length}, current ${current.length})`
  );
  out.push('', 'by reported version:');
  for (const { version, devices } of byVersion) out.push(`  ${version.padEnd(18)} ${devices}`);
  out.push('', `below the floor (${below.length}):`);
  for (const g of groupLaggards(below)) out.push(`  ${g.label.padEnd(24)} ${g.devices}`);
  if (withDevices) {
    for (const r of below) out.push(`    ${r.userId} ${r.deviceId} ${r.os ?? '-'} ${r.version} enrolled ${r.updatedAt ?? '-'}`);
  }
  out.push('', `unreported (${unreported.length}): no version stored, so neither below nor current`);
  return out.join('\n');
}

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WHO MAY CLAIM AN ACCOUNT'S KEYPACKAGES - AN ALLOWLIST, BECAUSE A CLAIM DESTROYS.
 *
 * `fetchUserDevices` deletes one one-time package from every device it lists. Production
 * 2026-11-06: roster readers (the settings count, the device panel, the device-notice wiring, the
 * Welcome fan-out) called it for ids and names and drained every pool of one account
 * (`docs/wiki/protocols/key-package-pool.md`). Only a caller about to ADD every listed device may
 * claim; every other one reads `listUserDevices`. A new claimer is added here on purpose, or not
 * at all.
 *
 * PER CALL SITE, NOT PER FILE: each file lists the function enclosing every claim it makes, one
 * entry per call. A per-file allowlist let a new roster-only claim through as long as it sat in a
 * file that already claimed - `groupCreation.ts` holds both adders and roster readers. A new call
 * fails here even beside an allowed one, and so does a claim moved into another function.
 */
const MAY_CLAIM: Record<string, string[]> = {
  // the definitions and their forwarding
  'lib/mls-client/IMlsService.ts': ['fetchUserDevices'],
  'lib/mls-client/mlsDeliveryApi.ts': ['fetchUserDevices'],
  'lib/services/BaseMlsService.ts': ['fetchUserDevices', 'fetchUserDevices'],
  // adders: group and direct-conversation creation add every device of a person (and the
  // creator's own), the Graine admission adds every device of a newcomer
  'lib/utils/chat/groupCreation.ts': [
    'createNewGroup',
    'readDevicesWithRetry',
    'startNewConversation',
  ],
  'lib/utils/graine/admitNewcomer.ts': ['admitNewcomerToDistributionGroup'],
};

const CLAIM = /\bfetchUserDevices\s*\(/;
/** A top-level declaration at column 0: a `function`, a `const` arrow, a `class` or `interface`. */
const TOP_LEVEL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=|(?:abstract\s+)?(class|interface)\s+\w+)/;
/** A member of a class or interface, at the two-space indent this codebase formats them to. */
const MEMBER = /^ {2}(?:(?:public|private|protected|static|readonly)\s+)*(?:async\s+)?(\w+)\s*[(<]/;

// Kept in a variable: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL.
const SRC_REL = '../..';
const SRC = fileURLToPath(new URL(SRC_REL, import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'wasm' || e.name === 'paraglide' ? [] : sources(path);
    const isSource = /\.(ts|svelte)$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name);
    return isSource && !path.includes(`${sep}test${sep}`) ? [path] : [];
  });
}

/**
 * The function enclosing each claim in `text`, one entry per call, sorted: the nearest top-level
 * function above it, or inside a class or interface the nearest member - a two-space line counts as
 * a member only there, since in a function body it is a statement (`if (`, `log(`).
 */
function claimSites(text: string): string[] {
  const sites: string[] = [];
  let enclosing = '<top level>';
  let inType = false;
  for (const line of text.split('\n')) {
    const top = TOP_LEVEL.exec(line);
    if (top) {
      inType = top[3] !== undefined;
      enclosing = top[1] ?? top[2] ?? '<top level>';
    } else if (inType) {
      const member = MEMBER.exec(line);
      if (member) enclosing = member[1];
    }
    if (CLAIM.test(line)) sites.push(enclosing);
  }
  return sites.sort();
}

describe('claiming the device list', () => {
  it('is done only at the call sites that add every device it lists', () => {
    const found: Record<string, string[]> = {};
    for (const path of sources(SRC)) {
      const sites = claimSites(readFileSync(path, 'utf8'));
      if (sites.length > 0) found[relative(SRC, path).split(sep).join('/')] = sites;
    }
    const allowed = Object.fromEntries(
      Object.entries(MAY_CLAIM).map(([path, sites]) => [path, [...sites].sort()])
    );
    expect(found).toEqual(allowed);
  });

  it('names the enclosing function of each call, so a second call beside an allowed one counts', () => {
    const text = [
      'export async function createNewGroup() {',
      '  await mlsService.fetchUserDevices(a);',
      '}',
      'export async function readRoster() {',
      '  if (ready) {',
      '    const ids = await mlsService.fetchUserDevices(b);',
      '  }',
      '}',
    ].join('\n');
    expect(claimSites(text)).toEqual(['createNewGroup', 'readRoster']);
  });
});

import { describe, expect, it } from 'vitest';
import { relativeTo, sourceFiles } from '../../test/sourceTree';

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
  // adders: group, "Mes notes" and direct-conversation creation add every device of a person (and
  // the creator's own - `createOwnedGroup` serves both a group and the self conversation), the
  // Graine admission adds every device of a newcomer
  'lib/utils/chat/groupCreation.ts': [
    'createOwnedGroup',
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

/**
 * Every shipped `.ts` / `.svelte` under `src`, from the run's source snapshot: tests and `test/`
 * directories are out, and the generated trees are never in it.
 */
const sources = () =>
  sourceFiles({ under: 'src', extensions: ['ts', 'svelte'], tests: 'exclude', skipDirs: ['test'] });

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
    const scanned = sources();
    // The tree the scan thinks it reads: an allowed file that is not in it would fail below, but a
    // wrong root would fail for the wrong reason.
    expect(scanned.map((f) => f.path)).toContain('src/lib/mls-client/IMlsService.ts');
    for (const { path, text } of scanned) {
      const sites = claimSites(text);
      if (sites.length > 0) found[relativeTo(path, 'src')] = sites;
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

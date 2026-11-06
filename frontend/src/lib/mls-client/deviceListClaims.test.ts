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
 */
const MAY_CLAIM = new Set([
  // the definitions and their forwarding
  'lib/mls-client/IMlsService.ts',
  'lib/mls-client/mlsDeliveryApi.ts',
  'lib/services/BaseMlsService.ts',
  // adders: group and direct-conversation creation add every device of a person, the Graine
  // admission adds every device of a newcomer
  'lib/utils/chat/groupCreation.ts',
  'lib/utils/graine/admitNewcomer.ts',
]);

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

describe('claiming the device list', () => {
  it('is done only by the callers that add every device it lists', () => {
    const claimers = sources(SRC)
      .filter((path) => /\bfetchUserDevices\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'));
    expect(claimers.length).toBeGreaterThan(0);
    expect(claimers.filter((path) => !MAY_CLAIM.has(path))).toEqual([]);
  });
});

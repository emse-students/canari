import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A PATCHED DEPENDENCY MUST NOT SILENTLY DROP ITS PATCH.
 *
 * bun keys a `patchedDependencies` entry to ONE exact version. When the installed version moves -
 * a Dependabot bump, a `bun update` inside the caret - bun applies nothing, prints nothing, and
 * removes the entry from `bun.lock` while `package.json` keeps it; `bun install --frozen-lockfile`
 * then passes. Measured 2026-10-13 with `svelte-dnd-action` 0.9.80 -> 0.9.79. The behaviour the
 * patch fixed comes back with every gate green unless a behavioural test happens to cover it, so
 * this asserts the precondition itself and names the way out: re-create the patch against the new
 * version (`bun patch <name>`), or delete it when upstream has fixed the defect.
 */

const frontendRoot = resolve(import.meta.dirname, '../..');

const pkg = JSON.parse(readFileSync(resolve(frontendRoot, 'package.json'), 'utf8')) as {
  patchedDependencies?: Record<string, string>;
};

/** `name@version` -> [name, version], scoped names included (`@scope/name@1.2.3`). */
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf('@');
  return [key.slice(0, at), key.slice(at + 1)];
}

describe('patchedDependencies', () => {
  const entries = Object.entries(pkg.patchedDependencies ?? {});

  it.each(entries)('%s is the version installed, and its patch file exists', (key, patchPath) => {
    const [name, version] = splitKey(key);
    expect(existsSync(resolve(frontendRoot, patchPath)), `missing patch file ${patchPath}`).toBe(
      true
    );
    const installed = (
      JSON.parse(
        readFileSync(resolve(frontendRoot, 'node_modules', name, 'package.json'), 'utf8')
      ) as { version: string }
    ).version;
    expect(
      installed,
      `${name} is installed at ${installed} but its patch is keyed to ${version}, so bun applied ` +
        `nothing: re-create ${patchPath} against ${installed} (bun patch ${name}), or delete it ` +
        `if upstream fixed the defect`
    ).toBe(version);
  });
});

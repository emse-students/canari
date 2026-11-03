import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * THE GUIDANCE MODULES IMPORT NO COMPONENT. Sign-out imports `guidance.svelte.ts` (to reset the
 * engine), and a component's graph reaches `globalChatSingleton` and so back to sign-out: importing
 * `NativeTabBar.svelte` for its state closed exactly that cycle and left a binding uninitialised at
 * load (`accountSwitchLateFlush.test.ts`, CI of #2952). The singleton's own cycle scan reads `.ts`
 * files only, so it did not see the edge through a `.svelte` file; this pins it here. A fact a
 * component owns lives in a plain module both import (`navigation/nativeTabBarState.svelte.ts`).
 */
const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, '..');

const VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Whether an import names a COMPONENT. A spec ending in `.svelte` may also be a `.svelte.ts` module
 * imported without its extension, so it is resolved on disk: a component is the one with no `.ts`.
 */
function isComponent(spec: string, from: string): boolean {
  if (!spec.endsWith('.svelte')) return false;
  const base = spec.startsWith('$lib/') ? join(lib, spec.slice(5)) : resolve(dirname(from), spec);
  return !existsSync(`${base}.ts`);
}

it('no guidance module imports a .svelte component', () => {
  const offenders = sources(here).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(VALUE_IMPORT)]
      .map((match) => match[1])
      .filter((spec) => isComponent(spec, file))
      .map((spec) => `${file} imports ${spec}`)
  );
  expect(offenders).toEqual([]);
});

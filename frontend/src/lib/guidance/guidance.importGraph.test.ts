import { dirname, join, normalize } from 'node:path/posix';
import { expect, it } from 'vitest';

import { hasSource, sourceFiles } from '../../test/sourceTree';

/**
 * THE GUIDANCE MODULES IMPORT NO COMPONENT. Sign-out imports `guidance.svelte.ts` (to reset the
 * engine), and a component's graph reaches `globalChatSingleton` and so back to sign-out: importing
 * `NativeTabBar.svelte` for its state closed exactly that cycle and left a binding uninitialised at
 * load (`accountSwitchLateFlush.test.ts`, CI of #2952). The singleton's own cycle scan reads `.ts`
 * files only, so it did not see the edge through a `.svelte` file; this pins it here. A fact a
 * component owns lives in a plain module both import (`navigation/nativeTabBarState.svelte.ts`).
 */
// POSIX, frontend-root-relative paths: the keys of the run's source snapshot, no disk read.
const here = 'src/lib/guidance';
const lib = 'src/lib';

const VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;

const sources = () => sourceFiles({ under: here, extensions: ['ts'], tests: 'exclude' });

/**
 * Whether an import names a COMPONENT. A spec ending in `.svelte` may also be a `.svelte.ts` module
 * imported without its extension, so it is resolved in the snapshot: a component is the one with no `.ts`.
 */
function isComponent(spec: string, from: string): boolean {
  if (!spec.endsWith('.svelte')) return false;
  const base = spec.startsWith('$lib/')
    ? join(lib, spec.slice(5))
    : normalize(join(dirname(from), spec));
  return !hasSource(`${base}.ts`);
}

it('no guidance module imports a .svelte component', () => {
  const files = sources();
  // The tree the scan thinks it reads: a wrong root would leave the offender list empty.
  expect(files.map((f) => f.path)).toContain('src/lib/guidance/guidance.svelte.ts');
  const offenders = files.flatMap(({ path, text }) =>
    [...text.matchAll(VALUE_IMPORT)]
      .map((match) => match[1])
      .filter((spec) => isComponent(spec, path))
      .map((spec) => `${path} imports ${spec}`)
  );
  expect(offenders).toEqual([]);
});

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

/**
 * NOTHING THE SINGLETON BUILDS MAY IMPORT THE SINGLETON BACK - except through the one door that
 * cannot be entered first.
 *
 * `globalChatSingleton` CALLS its five composables while it loads. So a module inside their import
 * tree that imports the singleton closes a cycle, and whenever that module happens to be loaded
 * before the singleton (a component importing it directly), the singleton runs mid-cycle and reads
 * a class that is not initialised yet. Measured 2026-09-28: `mediaTouch` imported `appendLog` from
 * here, and the dev server failed at random with `MediaService` read before initialization - on
 * `main` too, depending only on which module the page loaded first. `CallService` and
 * `outboxMirror` had the same edge. `appendLog` lives in `$lib/utils/sessionLog` now.
 *
 * The scan is static and reads value imports only (`import type` is erased). `ALLOWED` is a
 * cycle whose closing module is reachable ONLY through the singleton, so it cannot be entered first.
 */
const SRC = resolve(process.cwd(), 'src');
const SINGLETON = 'lib/stores/globalChatSingleton.svelte.ts';
const COMPOSABLES = [
  'lib/composables/useChatSession.svelte.ts',
  'lib/composables/useConversations.svelte.ts',
  'lib/composables/useMessaging.svelte.ts',
  'lib/composables/useChannelWorkspaces.svelte.ts',
  'lib/composables/useNotifications.svelte.ts',
];
/**
 * `groupCreation` reads `globalMessaging` inside functions, and is imported as a value only by
 * `useConversations`, which only the singleton imports as a value.
 */
const ALLOWED = new Set(['lib/utils/chat/groupCreation.ts']);

const IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('$lib/')) base = join(SRC, 'lib', spec.slice(5));
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  else return null;
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.svelte.ts`,
    `${base}.svelte`,
    join(base, 'index.ts'),
  ]) {
    if (existsSync(c) && !c.endsWith('/')) {
      try {
        readFileSync(c);
        return c;
      } catch {
        // a directory
      }
    }
  }
  return null;
}

function valueImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_RE)]
    .map((m) => resolveSpec(m[1] ?? m[2], file))
    .filter((f): f is string => f !== null);
}

/** Every module that imports the singleton, reachable from `start` without passing through it. */
function closersFrom(start: string): string[] {
  const singleton = join(SRC, SINGLETON);
  const seen = new Set([start]);
  const queue = [start];
  const closers: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const dep of valueImports(file)) {
      if (dep === singleton) {
        // POSIX separators, or `ALLOWED` never matches on Windows, where `relative` uses `\`.
        closers.push(relative(SRC, file).replaceAll('\\', '/'));
        continue;
      }
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return closers;
}

describe('globalChatSingleton import cycles', () => {
  it.each(COMPOSABLES)('%s never imports the singleton back', (composable) => {
    const closers = closersFrom(join(SRC, composable)).filter((f) => !ALLOWED.has(f));
    expect(closers).toEqual([]);
  });
});

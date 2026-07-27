/// <reference types="jest" />

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Infra-free DI guardrail: every entity injected via `@InjectRepository(Entity)` MUST be
 * registered in a `TypeOrmModule.forFeature([...])`, otherwise the `<Entity>Repository` provider
 * does not exist and the NestJS bootstrap throws `UnknownDependenciesException` AT STARTUP (a
 * runtime error invisible to `tsc` and to unit specs that do not compile `AppModule`).
 *
 * This test re-reads the sources (no DB/Redis): it would have caught the missing
 * `UserDismissedGroup` in `forFeature` that put the service in a crash-loop and broke CD.
 */

const SRC_ROOT = __dirname;

/** Recursively lists the `.ts` files under src (excluding specs, declarations and node_modules). */
function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Valid TS identifier (filters out comments/stray tokens inside an array). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe('AppModule - TypeORM repository DI registration', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('every @InjectRepository(Entity) is present in a TypeOrmModule.forFeature([…])', () => {
    // 1. All entities injected via @InjectRepository(X), with the file of the first occurrence.
    const injectedAt = new Map<string, string>();
    const injectRe = /@InjectRepository\(\s*([A-Za-z0-9_]+)\s*\)/g;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = injectRe.exec(src)) !== null) {
        if (!injectedAt.has(m[1])) injectedAt.set(m[1], file);
      }
    }

    // 2. All entities registered in a forFeature([…]) (any module).
    const registered = new Set<string>();
    const forFeatureRe = /forFeature\(\s*\[([\s\S]*?)\]/g;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = forFeatureRe.exec(src)) !== null) {
        for (const token of m[1].split(',').map((s) => s.trim())) {
          if (IDENTIFIER.test(token)) registered.add(token);
        }
      }
    }

    // 3. Any entity injected but not registered would break bootstrap.
    const missing = [...injectedAt.keys()].filter((e) => !registered.has(e));
    if (missing.length > 0) {
      const detail = missing.map((e) => `  - ${e} (injected in ${injectedAt.get(e)})`).join('\n');
      throw new Error(
        `Entity/entities injected via @InjectRepository missing from TypeOrmModule.forFeature ` +
          `(NestJS bootstrap would fail at startup):\n${detail}`
      );
    }

    // Sanity: injections were actually detected (otherwise the scan is broken and guards nothing).
    expect(injectedAt.size).toBeGreaterThan(0);
  });
});

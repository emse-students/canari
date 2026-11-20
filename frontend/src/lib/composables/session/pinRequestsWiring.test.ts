import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * EVERY PIN REQUEST RUNS UNDER THE REQUEST DEADLINE, AND ONLY A CONFIRMED FIRST SETUP MAY CREATE.
 *
 * Two wirings no behaviour test of one module can hold (PIN audit, 2026-11-20, rows 11 and 15):
 *
 * - A bare `fetch(` to `/api/mls/security/pin-*` has no deadline: a request the network swallows
 *   leaves the keypad spinning for ever. Every one goes through `fetchOrUnreachable` (or its PIN-reset
 *   wrapper `pinServerFetch`), which turns no answer into the typed "unreachable".
 * - `pin-check` REGISTERS a PIN on `intent: 'create'` alone. The gate sets it from `isFirstPinSetup`
 *   - a gate that asked the PIN twice - at ONE place, and resets it once that submit's login
 *   settled, so a later saved-PIN or biometric login never carries a stale `create`.
 */
// FROM `process.cwd()`, as the sibling guards: Vite hands a non-`file:` `import.meta.url` here.
const root = join(process.cwd(), 'src');

/** Every non-test `.ts` / `.svelte` source under `src/`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    const isSource = /\.(ts|svelte)$/.test(name) && !/\.test\.ts$|\.spec\.ts$/.test(name);
    return isSource ? [path] : [];
  });
}

describe('PIN requests', () => {
  it('no bare fetch( reaches /api/mls/security/pin-*', () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      // A bare call: `fetch(` not preceded by an identifier character or a dot.
      for (const call of text.matchAll(/(?<![\w.$])fetch\(/g)) {
        const argument = text.slice(call.index, call.index + 240);
        if (argument.includes('/api/mls/security/pin-')) {
          offenders.push(`${relative(root, file)} @${call.index}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard sees the PIN requests it is about (it would pass on an empty tree otherwise)', () => {
    const named = sources(root).filter((file) =>
      readFileSync(file, 'utf8').includes('/api/mls/security/pin-')
    );
    expect(named.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the PIN intent', () => {
  const gate = readFileSync(
    join(root, 'lib/components/layout/ChatBackgroundService.svelte'),
    'utf8'
  );
  const submit = gate.slice(
    gate.indexOf('function handlePinSubmit('),
    gate.indexOf('\n  }\n', gate.indexOf('function handlePinSubmit('))
  );

  it('handlePinSubmit sends create only when the gate is a first setup', () => {
    expect(submit).toContain("globalSession.pinIntent = isFirstPinSetup ? 'create' : 'unlock';");
  });

  it('no other place of the app writes the intent', () => {
    const writers = sources(root).filter((file) =>
      /\.pinIntent\s*=(?!=)/.test(readFileSync(file, 'utf8'))
    );
    expect(writers.map((file) => relative(root, file).replaceAll(sep, '/'))).toEqual([
      'lib/components/layout/ChatBackgroundService.svelte',
    ]);
    expect(gate.match(/\.pinIntent\s*=(?!=)/g)).toHaveLength(2);
  });

  it('the submit resets the intent to unlock once its login settled', () => {
    const settle = submit.indexOf('.finally(() => {');
    expect(settle).toBeGreaterThan(-1);
    expect(submit.slice(settle, settle + 400)).toContain("globalSession.pinIntent = 'unlock';");
  });
});

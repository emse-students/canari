import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * EVERY PIN REQUEST RUNS UNDER THE REQUEST DEADLINE, AND ONLY A CONFIRMED FIRST SETUP MAY CREATE.
 *
 * Two wirings no behaviour test of one module can hold (PIN audit, 2026-11-20, rows 11 and 15):
 *
 * - A PIN request built at a call site can skip the deadline: a bare `fetch(` - or a URL kept in a
 *   variable and fetched later - leaves the keypad spinning for ever. So the route path exists in ONE
 *   module, `pinServer.ts`, whose one request is `fetchOrUnreachable`; every caller names a route. The
 *   guard is STRUCTURAL: the path segment `mls/security` written in code anywhere else fails, however
 *   the URL around it is built.
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

/** `text` without its comments: `/* ... *\/` blocks, `<!-- -->` and whole-line `//` comments. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const HELPER = join(root, 'lib/composables/session/pinServer.ts');

/** The tree, read and stripped ONCE: walking 3000 sources per test is what times a test out. */
const tree = sources(root).map((file) => {
  const text = readFileSync(file, 'utf8');
  return { file, name: relative(root, file).replaceAll(sep, '/'), text, code: code(text) };
});

describe('PIN requests', () => {
  it('the PIN route path is written in pinServer.ts alone', () => {
    const offenders = tree
      .filter((source) => source.file !== HELPER && source.code.includes('mls/security'))
      .map((source) => source.name);
    expect(offenders).toEqual([]);
  });

  it('pinServer.ts builds the path, and its one request is under the deadline', () => {
    const helper = code(readFileSync(HELPER, 'utf8'));
    expect(helper).toContain('/api/mls/security/');
    expect(helper).toContain('return fetchOrUnreachable(url, init,');
    // The only other way out is a test's injected transport; never the global `fetch`.
    expect(helper).not.toMatch(/(?<![\w.$])fetch\(/);
  });

  it('the strip keeps code and drops comments (so the first guard cannot pass vacuously)', () => {
    expect(code('const u = `${b}/api/mls/security/pin-check`;')).toContain('mls/security');
    expect(code('/** see `/api/mls/security/pin-salt` */\nconst x = 1;')).not.toContain(
      'mls/security'
    );
    expect(code('  // GET /api/mls/security/pin-salt\nconst x = 1;')).not.toContain('mls/security');
  });

  it('every PIN call site goes through pinServerRequest', () => {
    const callers = tree.filter((source) => source.code.includes('pinServerRequest('));
    expect(callers.map((source) => source.name).sort()).toEqual([
      'lib/components/layout/ChatBackgroundService.svelte',
      'lib/composables/session/pinReset.ts',
      'lib/composables/session/pinServer.ts',
      'lib/composables/session/pinStatus.ts',
      'lib/composables/session/sessionAuth.ts',
    ]);
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
    const writers = tree.filter((source) => /\.pinIntent\s*=(?!=)/.test(source.text));
    expect(writers.map((source) => source.name)).toEqual([
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

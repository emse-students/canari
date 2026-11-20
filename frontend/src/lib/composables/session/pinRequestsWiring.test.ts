import { withoutAnyComments } from '$lib/styles/markupSources';
import { readSource, relativeTo, sourceFiles } from '../../../test/sourceTree';

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
const HELPER = 'lib/composables/session/pinServer.ts';

/**
 * The non-test sources, their CODE read through the repository's one comment stripper: a file may
 * name the route in prose, only code counts.
 */
const tree = sourceFiles({ under: 'src', extensions: ['ts', 'svelte'], tests: 'exclude' }).map(
  ({ path, text }) => ({ name: relativeTo(path, 'src'), text, code: withoutAnyComments(text) })
);

describe('PIN requests', () => {
  it('reads the tree it thinks it is', () => {
    expect(tree.length).toBeGreaterThan(500);
    expect(tree.map((source) => source.name)).toContain(HELPER);
  });

  it('the PIN route path is written in pinServer.ts alone', () => {
    const offenders = tree
      .filter((source) => source.name !== HELPER && source.code.includes('mls/security'))
      .map((source) => source.name);
    expect(offenders).toEqual([]);
  });

  it('pinServer.ts builds the path, and its one request is under the deadline', () => {
    const helper = withoutAnyComments(readSource(`src/${HELPER}`));
    expect(helper).toContain('/api/mls/security/');
    expect(helper).toContain('return fetchOrUnreachable(url, init,');
    // The only other way out is a test's injected transport; never the global `fetch`.
    expect(helper).not.toMatch(/(?<![\w.$])fetch\(/);
  });

  it('the strip keeps code and drops comments (so the first guard cannot pass vacuously)', () => {
    expect(withoutAnyComments('const u = `${b}/api/mls/security/pin-check`;')).toContain(
      'mls/security'
    );
    expect(withoutAnyComments('// GET /api/mls/security/pin-salt\nconst x = 1;')).not.toContain(
      'mls/security'
    );
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
  const gate = readSource('src/lib/components/layout/ChatBackgroundService.svelte');
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

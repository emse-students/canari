import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A DAMAGED LOCAL STATE MUST NOT BE CALLED A FIRST CONNECTION, because that is what hides the way out.
 *
 * WHAT BROKE, MEASURED ON W2 ON 2026-09-21. `isFirstPinSetup` is computed from a SERVER fact -
 * whether this account has a `PinVerifier` row (`askPinStatus`; since 2026-11-20 an unanswered
 * question is its own gate state, never a default).
 * `local_state_unopenable` is a LOCAL fact, raised when this device's own MLS blob will not open.
 * NOTHING SAID THE TWO COULD NOT BE TRUE AT ONCE, and they were: the modal announced "Premiere
 * connexion - choisissez votre PIN", accepted a PIN, and answered that the messages stored here
 * could not be opened and that only a reset restores access - with the reset nowhere on screen,
 * because `{#if !isFirstSetup}` in `PinModal.svelte` gates BOTH exits it names, the old-PIN
 * recovery and the reset. A reader in that state cannot unlock and cannot reach the one remedy
 * they were given. It is reachable in production: a
 * `pin-reset` whose server half lands and whose `resetDeviceAsFresh` half does not leaves exactly
 * this pair, so the trap is produced by the very control that escapes it.
 *
 * THE PROOF THE FIX IS THE RIGHT ONE IS THAT THE PATHS ALREADY DISAGREED. `onSavedPinFailed` - the
 * STORED-PIN path - has always cleared the flag on a rejection. The two INTERACTIVE handlers, the
 * ones a person reaches by typing, never did. One implementation now, `applyPinFailure`, and it
 * branches on the typed `LoginErrorCode` rather than on the localized message.
 *
 * WHY A SOURCE GUARD AND NOT A RENDER TEST. The behaviour spans a Svelte component's private state,
 * three callback sites handed to a session composable, and a fetch to `pin-status`; a harness
 * faking all three would assert its own mocks. What actually broke is a MISSING STATEMENT in two
 * of three sibling handlers, which is precisely what a source guard pins well - and what a fourth
 * handler, added later, would reintroduce with every other test green. Same technique and same
 * reasoning as `sessionExpiredRelease.test.ts` beside it.
 */
// FROM `process.cwd()`, for the reason the sibling guard states: under this directory Vite hands
// the module a non-`file:` `import.meta.url`, and `fileURLToPath` then throws.
const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

const modal = readFileSync(join(process.cwd(), 'src/lib/components/auth/PinModal.svelte'), 'utf8');

/** The body of `applyPinFailure`, or `null` if it has gone. */
function applyPinFailureBody(): string | null {
  const start = source.indexOf('function applyPinFailure(');
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

describe('a failure that proves a local state exists refutes "first setup"', () => {
  it('has one handler for what a failed unlock changes about the modal', () => {
    expect(applyPinFailureBody()).not.toBeNull();
  });

  it('clears the first-setup flag on a code that proves there is a local state', () => {
    const body = applyPinFailureBody()!;

    expect(body).toContain('provesLocalStateExists(code)');
    expect(body).toContain('isFirstPinSetup = false');
  });

  it('asks the typed code, never the localized sentence', () => {
    const body = applyPinFailureBody()!;

    // A regex over the message stops matching the day the string is reworded or translated, which
    // is the whole reason `LoginErrorCode` exists. See `loginErrors.ts`.
    expect(body).not.toMatch(/auth_local_state_unopenable|\.message|indexOf\(|includes\(/);
  });

  it('is the ONLY route into the recovery evaluation, so no handler can skip it', () => {
    // THE DEFECT WAS A HANDLER THAT DID HALF OF THIS. Two of the three called
    // `evaluateRecoverable` directly and left the flag alone; a fourth written tomorrow would copy
    // whichever it found. There is one spelling to copy now.
    const calls = source.match(/evaluateRecoverable\(/g) ?? [];
    // Its own declaration, and exactly one call - the one inside `applyPinFailure`.
    expect(calls).toHaveLength(2);
    expect(applyPinFailureBody()!).toContain('evaluateRecoverable(uid, code)');
  });

  it('routes every failure handler through it (stored PIN, submit, biometric, recovery)', () => {
    // The stored-PIN path, the interactive submit, and the biometric fallback. A count, because
    // their bodies differ and only the dispatch is shared; the PIN recovery's removed-device route is the fourth caller.
    expect(source.match(/applyPinFailure\(/g) ?? []).toHaveLength(5);
  });

  it('asks neither a salt nor a recovery for an account deleted from this device', () => {
    // Review of #2023: the code `account_deleted` reached `askSaltForNextTry` (a salt request for an
    // account that exists nowhere) and `evaluateRecoverable`. Both are skipped, as the salt already
    // was for `device_revoked`, by a branch that returns BEFORE either call.
    const body = applyPinFailureBody()!;
    for (const guard of ["if (code === 'account_deleted')", 'if (removedNotice) {']) {
      const branch = body.indexOf(guard);
      expect(branch, guard).toBeGreaterThan(-1);
      const end = body.indexOf('return;', branch);
      expect(end).toBeGreaterThan(branch);
      expect(end).toBeLessThan(body.indexOf('evaluateRecoverable(uid, code)'));
      expect(end).toBeLessThan(body.indexOf('askSaltForNextTry()'));
      expect(body.slice(branch, end)).toContain('canRecoverPin = false');
    }
  });

  it('shows a removed device the gate without a keypad, never the keypad then /login (row 18)', () => {
    const body = applyPinFailureBody()!;
    expect(body).toContain('const removedNotice = noKeypadNoticeFor(code);');
    const branch = body.indexOf('if (removedNotice) {');
    const end = body.indexOf('return;', branch);
    expect(body.slice(branch, end)).toContain('pinGateNotice = removedNotice');
    expect(body.slice(branch, end)).toContain('pinGateRetry = null');
  });

  it('still gates both exits on the flag, which is why clearing it is the fix', () => {
    // If `PinModal` stopped hiding them, this guard would be pinning a statement that no longer
    // matters - and would say so here rather than quietly passing for ever.
    expect(modal).toContain('{#if !gateNotice && !isFirstSetup && onRecoverPin && displayError}');
    expect(modal).toContain('{#if !isFirstSetup}');
  });
});

/**
 * AN ACCOUNT WITH NO PIN HAS NOTHING TO RECOVER TO (review of #3909). The recovery types the server's
 * `not-set` as `pin_not_set`; the gate must then leave the recovery and ask a first PIN - through the
 * one function that also drops this device's stale PIN proof.
 */
describe('a recovery answered pin_not_set becomes a first setup', () => {
  const body = (head: string) => {
    const start = source.indexOf(head);
    expect(start, head).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n  }\n', start));
  };

  it('closes the recovery modal and enters first setup, from the TYPE', () => {
    const recover = body('async function handleRecoverSubmit(');
    const branch = recover.indexOf("e instanceof LoginFailure && e.code === 'pin_not_set'");
    expect(branch).toBeGreaterThan(recover.indexOf('} catch (e) {'));
    const handled = recover.slice(branch, recover.indexOf('}', branch));
    expect(handled).toContain('showRecoverModal = false;');
    expect(handled).toContain('enterFirstPinSetup(uid);');
  });

  it('dismissAuthPrompts closes the recovery modal too, so a session expiry never leaves it over /login', () => {
    const dismiss = body('function dismissAuthPrompts(');
    expect(dismiss).toContain('showRecoverModal = false;');
    expect(dismiss).toContain('showPinModal = false;');
  });

  it('enterFirstPinSetup draws the first-setup gate and drops the PIN proof', () => {
    const enter = body('function enterFirstPinSetup(');
    expect(enter).toContain('isFirstPinSetup = true;');
    expect(enter).toContain('forgetPinProven(localStorage, uid);');
  });
});

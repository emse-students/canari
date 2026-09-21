import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A DAMAGED LOCAL STATE MUST NOT BE CALLED A FIRST CONNECTION, because that is what hides the way out.
 *
 * WHAT BROKE, MEASURED ON W2 ON 2026-09-21. `isFirstPinSetup` is computed by `detectFirstPinSetup`
 * from a SERVER fact - whether this account has a `PinVerifier` row - and it is careful about it:
 * it defaults to `false` on any failure so the "first setup" wording is never shown by mistake.
 * `local_state_unopenable` is a LOCAL fact, raised when this device's own MLS blob will not open.
 * NOTHING SAID THE TWO COULD NOT BE TRUE AT ONCE, and they were: the modal announced "Premiere
 * connexion - choisissez votre PIN", accepted a PIN, and answered that the messages stored here
 * could not be opened and that only a reset restores access - with the reset nowhere on screen,
 * because `{#if !isFirstSetup}` in `PinModal.svelte` gates BOTH exits it names, the old-PIN
 * recovery and the reset. A reader in that state cannot unlock and cannot reach the one remedy
 * they were given. It is reachable in production the same way `auth_reset_device_partial` is: a
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

  it('routes all three failure handlers through it', () => {
    // The stored-PIN path, the interactive submit, and the biometric fallback. A count, because
    // their bodies differ and only the dispatch is shared.
    expect(source.match(/applyPinFailure\(/g) ?? []).toHaveLength(4);
  });

  it('still gates both exits on the flag, which is why clearing it is the fix', () => {
    // If `PinModal` stopped hiding them, this guard would be pinning a statement that no longer
    // matters - and would say so here rather than quietly passing for ever.
    expect(modal).toContain('{#if !isFirstSetup && onRecoverPin && displayError}');
    expect(modal).toContain('{#if !isFirstSetup}');
  });
});

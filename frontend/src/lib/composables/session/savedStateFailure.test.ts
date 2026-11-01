// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SavedStateOfAnotherAccountError, SavedStateUnopenedError } from '$lib/mls-client';
import { m } from '$lib/paraglide/messages';
import { MlsStateWriteRefusedError } from '$lib/utils/hex';
import { savedStateFailure } from './sessionAuth';
import { isRecoverableWithOldPin, provesOtherAccountState } from './loginErrors';

/**
 * THE LOGIN READS WHY A SAVED STATE DID NOT OPEN FROM A TYPE, AND SAYS ONLY WHAT THE CAUSE EARNED.
 *
 * Until 2026-10-17 it compared `reason.message` against one shared marker, so every cause - a PIN
 * changed elsewhere, a damaged state, another account's - wore the same sentence, which offered both
 * remedies and named neither (`serverProse.test.ts` held the site on its allowlist for it).
 */
describe('savedStateFailure', () => {
  it("names another account's state, and the gate then withholds the reset", () => {
    const failure = savedStateFailure(new SavedStateOfAnotherAccountError(new Error('x')));
    expect(failure.code).toBe('device_holds_other_account');
    expect(failure.message).toBe(m.auth_vault_other_account_device());
    expect(provesOtherAccountState(failure.code)).toBe(true);
    expect(isRecoverableWithOldPin(failure.code)).toBe(false);
  });

  it('states a PIN changed elsewhere as the fact a fingerprint makes it, and offers the old PIN', () => {
    const failure = savedStateFailure(new SavedStateUnopenedError('rotated', new Error('x')));
    expect(failure.code).toBe('local_state_sealed_under_old_pin');
    expect(failure.message).toBe(m.auth_local_state_old_pin());
    expect(isRecoverableWithOldPin(failure.code)).toBe(true);
  });

  it('keeps the observation, both remedies named, for a legacy blob or an untyped failure', () => {
    const failure = savedStateFailure(new SavedStateUnopenedError('undecryptable', new Error('x')));
    expect(failure.code).toBe('local_state_unopenable');
    expect(failure.message).toBe(m.auth_local_state_unopenable());
  });

  it('says retry-first, with no reset, for an untyped cause that proves nothing about the bytes', () => {
    const failure = savedStateFailure(new SavedStateUnopenedError('unknown', new Error('x')));
    expect(failure.code).toBe('local_state_unknown');
    expect(failure.message).toBe(m.auth_local_state_unknown());
    expect(failure.message).not.toBe(m.auth_local_state_unopenable());
    expect(isRecoverableWithOldPin(failure.code)).toBe(false);
    expect(provesOtherAccountState(failure.code)).toBe(false);
  });

  it('keeps its own sentence for a state unreadable right now', () => {
    const failure = savedStateFailure(
      new SavedStateUnopenedError('unreadable_now', new Error('x'))
    );
    expect(failure.code).toBe('local_state_unreadable_now');
    expect(failure.message).toBe(m.auth_local_state_unreadable_now());
  });

  it('names another tab, and offers neither the old PIN nor a reset, when a rotation was refused', () => {
    // The rotation could not record its fresh state because another tab of this account wrote the
    // stored one (`MlsStateWriteRefusedError`). Nothing durable moved; it used to reach the login as
    // an untyped failure, worded as whatever English the error carried.
    const failure = savedStateFailure(new MlsStateWriteRefusedError('stale'));
    expect(failure.code).toBe('state_written_by_another_tab');
    expect(failure.message).toBe(m.auth_state_written_by_another_tab());
    expect(isRecoverableWithOldPin(failure.code)).toBe(false);
    expect(provesOtherAccountState(failure.code)).toBe(false);
  });

  it('is what the login throws for every type, read by `instanceof` and never by the message', () => {
    // WHY A SOURCE TEST (WP-T5: keep). The throw sits inside `loginImpl`, a flow over a live MLS
    // init, a vault and a gateway; what the function above returns is driven by the cases above, and
    // that the login reaches it by TYPE rather than by the retired message marker is one statement.
    const auth = readFileSync(join(import.meta.dirname, 'sessionAuth.ts'), 'utf8');
    expect(auth).toMatch(
      /reason instanceof SavedStateUnopenedError \|\|\s+reason instanceof SavedStateOfAnotherAccountError \|\|\s+reason instanceof MlsStateWriteRefusedError\s+\) \{\s+throw savedStateFailure\(reason\);/
    );
    expect(auth).not.toContain('MLS_LOCAL_STATE_UNDECRYPTABLE');
  });
});

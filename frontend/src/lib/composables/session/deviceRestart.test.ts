/**
 * A PHONE WHOSE HARDWARE-HELD KEY IS PROVEN GONE RESTARTS BY ITSELF AS A NEW DEVICE (owner,
 * 2026-11-20), and nothing else does.
 *
 * Measured on a real phone change: the transfer copied the app's data but not the keystore key, the
 * PIN was right, and the gate asked the person to "reset the messaging" through a button that did not
 * exist under that name. The decision: a PIN the server accepted over a key proven gone (`absent`,
 * `mismatch`) discards this device's state and enrols it afresh - through the forgot-PIN reset's LOCAL
 * half only, never `pin-reset`, which deletes the account's PIN and purges every device.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hardwareKeyLoginFailure, offersDeviceRestart, type LoginErrorCode } from './loginErrors';
import { decideAutomaticRestart, noServerPinBasis, runDeviceRestart } from './pinReset';

const NO_FACT = { otherAccountState: false, alreadyRestarted: false };
const quiet = () => {};

/** The code the unlock reports for a keystore refusal - built by the one function that decides it. */
function codeOf(refusal: 'absent' | 'mismatch' | 'unreadable'): LoginErrorCode {
  vi.spyOn(console, 'error').mockImplementation(quiet);
  const code = hardwareKeyLoginFailure(refusal, quiet).code;
  vi.restoreAllMocks();
  return code;
}

describe('the automatic restart - decided by the typed code', () => {
  it('restarts on an EMPTY keystore entry (`absent`)', () => {
    expect(decideAutomaticRestart(codeOf('absent'), NO_FACT)).toBe('automatic');
  });

  it('restarts on an entry holding ANOTHER key (`mismatch`)', () => {
    expect(decideAutomaticRestart(codeOf('mismatch'), NO_FACT)).toBe('automatic');
  });

  it('NEVER on a key that could not be read now - it may still exist', () => {
    const code = codeOf('unreadable');
    expect(code).toBe('hardware_key_unreadable');
    expect(decideAutomaticRestart(code, NO_FACT)).toBe('none');
    expect(offersDeviceRestart(code)).toBe(false);
  });

  it("NEVER over another account's state - nothing of that account is deleted", () => {
    expect(
      decideAutomaticRestart('hardware_key_unavailable', { ...NO_FACT, otherAccountState: true })
    ).toBe('withheld_other_account');
  });

  it('not twice in one page - a key gone again right after a restart could only loop', () => {
    expect(
      decideAutomaticRestart('hardware_key_unavailable', { ...NO_FACT, alreadyRestarted: true })
    ).toBe('already_restarted');
  });

  it('not on any other code: a wrong PIN, an unopenable state (a button there), no code', () => {
    for (const code of ['pin_mismatch', 'local_state_unopenable', 'other', undefined] as const) {
      expect(decideAutomaticRestart(code, NO_FACT), String(code)).toBe('none');
    }
  });

  it('accuses the key gone at ERROR, with its refusal - the data travelled without its key', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(quiet);
    hardwareKeyLoginFailure('absent', quiet);
    expect(String(error.mock.calls[0]?.[0])).toContain('(absent)');
    vi.restoreAllMocks();
  });
});

describe('runDeviceRestart - the forgot-PIN reset LOCAL half, and only it', () => {
  it('stages under the no-PIN basis, then commits - so a cut restart is committed by the next settle', async () => {
    const order: string[] = [];
    const stage = vi.fn(async (basis: string) => {
      order.push(`stage ${basis}`);
    });
    await runDeviceRestart({
      stage,
      commit: async () => {
        order.push('commit');
      },
      log: quiet,
    });
    expect(order).toEqual([`stage ${await noServerPinBasis()}`, 'commit']);
  });

  it('a refused stage removes nothing', async () => {
    const commit = vi.fn(async () => {});
    await expect(
      runDeviceRestart({
        stage: async () => {
          throw new Error('refused');
        },
        commit,
        log: quiet,
      })
    ).rejects.toThrow('refused');
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('the shell - wired to the local half, never to the server reset', () => {
  const shell = readFileSync(
    join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
    'utf8'
  );
  const restart = shell.slice(
    shell.indexOf('async function restartThisDevice('),
    shell.indexOf('async function handlePinReset(')
  );

  it('restarts through the stage and commit the forgot-PIN reset uses', () => {
    expect(restart).toContain('runDeviceRestart({');
    expect(restart).toContain('globalSession.stageDeviceReset(uid, basis)');
    expect(restart).toContain('globalSession.resetDeviceAsFresh(uid, sessionCb())');
  });

  it('never asks the server to reset the PIN (it would purge every device of the account)', () => {
    expect(restart).not.toContain('pin-reset');
    expect(restart).not.toContain('runPinReset');
  });

  it("refuses on the act itself over another account's state or a key that may exist", () => {
    expect(restart).toContain('if (deviceHoldsOtherAccount || keyReadRefused) {');
  });

  it('decides the automatic restart from the typed code, with the other-account fact', () => {
    expect(shell).toMatch(
      /decideAutomaticRestart\(code, \{\s+otherAccountState: deviceHoldsOtherAccount \|\| provesOtherAccountState\(code\),/
    );
  });

  it('offers the direct button from the typed code, withheld like the reset', () => {
    expect(shell).toContain('restartOffered = offersDeviceRestart(code);');
    expect(shell).toContain(
      'onRestartDevice={restartOffered && !deviceHoldsOtherAccount && !keyReadRefused'
    );
  });
});

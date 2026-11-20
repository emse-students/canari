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
import type { AtRestKeyScheme } from '$lib/crypto/hardwareHeldKey';
import {
  hardwareKeyLoginFailure,
  offersDeviceRestart,
  offersForgotPinReset,
  type LoginErrorCode,
} from './loginErrors';
import {
  decideAutomaticRestart,
  DeviceRestartUnfinishedError,
  noServerPinBasis,
  runDeviceRestart,
  settleUnsettledPinReset,
  type DeviceRestartSteps,
} from './pinReset';

const NO_FACT = { otherAccountState: false, alreadyRestarted: false };
const quiet = () => {};

/** The code the unlock reports for a keystore refusal - built by the one function that decides it. */
function codeOf(refusal: 'absent' | 'mismatch' | 'unreadable'): LoginErrorCode {
  return hardwareKeyLoginFailure(refusal, quiet).code;
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

  it('carries the refusal to the one accusing line, and accuses nothing itself', () => {
    // It runs before the server answered the PIN: a wrong PIN over a lost key must not accuse.
    const error = vi.spyOn(console, 'error').mockImplementation(quiet);
    const failure = hardwareKeyLoginFailure('mismatch', quiet);
    expect(failure.refusal).toBe('mismatch');
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('the account-wide forgot-PIN reset - withheld where the device restart is the remedy', () => {
  const none = { otherAccountState: false, keyReadRefused: false, restartOffered: false };

  it('is offered on an ordinary gate', () => {
    expect(offersForgotPinReset(none)).toBe(true);
  });

  it("is withheld over another account's state, an unread key, or a broken state the PIN opened", () => {
    expect(offersForgotPinReset({ ...none, otherAccountState: true })).toBe(false);
    expect(offersForgotPinReset({ ...none, keyReadRefused: true })).toBe(false);
    expect(offersForgotPinReset({ ...none, restartOffered: true })).toBe(false);
  });

  it('stays offered on the saved/biometric `hardware_key_unavailable` path (no restart offered there)', () => {
    expect(offersDeviceRestart('hardware_key_unavailable')).toBe(false);
    expect(offersForgotPinReset(none)).toBe(true);
  });
});

/** A restart's steps over a small model of the disk: the journalled stage and the at-rest marker. */
function disk(opts: { commitClearsMarker: boolean }) {
  const order: string[] = [];
  const state = { journal: null as string | null, marker: 'hardware' as AtRestKeyScheme };
  const steps: DeviceRestartSteps = {
    stage: vi.fn(async (basis: string) => {
      order.push('stage');
      state.journal = basis;
    }),
    commit: vi.fn(async () => {
      order.push('commit');
      state.journal = null;
      // The real commit swallows a database that would not clear (the marker is then KEPT).
      if (opts.commitClearsMarker) state.marker = 'pin-derived';
    }),
    atRestScheme: vi.fn(async () => {
      order.push('scheme');
      return state.marker;
    }),
    log: quiet,
  };
  return { order, state, steps };
}

describe('runDeviceRestart - the forgot-PIN reset LOCAL half, and only it', () => {
  it('stages under the no-PIN basis, commits, then reads the end state from the disk', async () => {
    const { order, state, steps } = disk({ commitClearsMarker: true });
    await runDeviceRestart(steps);
    expect(order).toEqual(['stage', 'commit', 'scheme']);
    expect(steps.stage).toHaveBeenCalledWith(await noServerPinBasis());
    expect(state.marker).toBe('pin-derived');
  });

  it('a commit that returned while the marker still reads hardware is NOT a restart', async () => {
    const { steps } = disk({ commitClearsMarker: false });
    const run = runDeviceRestart(steps);
    await expect(run).rejects.toBeInstanceOf(DeviceRestartUnfinishedError);
    await expect(run).rejects.toMatchObject({ scheme: 'hardware' });
  });

  it('an end state the disk cannot say is not a restart either', async () => {
    const { steps } = disk({ commitClearsMarker: true });
    steps.atRestScheme = async () => 'unreadable';
    await expect(runDeviceRestart(steps)).rejects.toMatchObject({ scheme: 'unreadable' });
  });

  it('a refused stage removes nothing', async () => {
    const { steps } = disk({ commitClearsMarker: true });
    steps.stage = async () => {
      throw new Error('refused');
    };
    await expect(runDeviceRestart(steps)).rejects.toThrow('refused');
    expect(steps.commit).not.toHaveBeenCalled();
  });

  it('a restart cut after its stage is COMMITTED by the next sign-in, never put back', async () => {
    const { state, steps } = disk({ commitClearsMarker: true });
    steps.commit = async () => {
      throw new Error('the page went away');
    };
    await expect(runDeviceRestart(steps)).rejects.toThrow('the page went away');
    expect(state.journal).toBe(await noServerPinBasis());

    // The next sign-in: the server still holds the account's PIN (its salt is not the empty one).
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    const outcome = await settleUnsettledPinReset({
      adopt: async () => state.journal,
      serverSaltFingerprint: async () => 'f'.repeat(64),
      commit,
      rollback,
      log: quiet,
    });
    expect(outcome).toBe('committed_pin_chosen');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });
});

describe('the shell - wired to the local half, never to the server reset', () => {
  // The shell is a 2,500-line component no test mounts; what it decides is tested above, and only
  // the wiring of those decisions is read here.
  const shell = readFileSync(
    join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
    'utf8'
  );
  const restart = shell.slice(
    shell.indexOf('async function restartThisDevice('),
    shell.indexOf('async function handlePinReset(')
  );

  it('restarts through the stage, the commit and the disk read, never the server reset', () => {
    expect(restart).toContain('runDeviceRestart({');
    expect(restart).toContain('globalSession.stageDeviceReset(uid, basis)');
    expect(restart).toContain('globalSession.resetDeviceAsFresh(uid, sessionCb())');
    expect(restart).toContain('tauriHardwareKeyPort.scheme(uid)');
    expect(restart).not.toContain('pin-reset');
    expect(restart).not.toContain('runPinReset');
  });

  it('unlocks again only after a restart the disk confirmed', () => {
    const failure = restart.indexOf('pinError = m.auth_device_restart_failed();');
    const unlockAgain = restart.indexOf('handlePinSubmit(pin);');
    expect(failure).toBeGreaterThan(0);
    expect(restart.slice(failure, unlockAgain)).toContain('return;');
  });
});

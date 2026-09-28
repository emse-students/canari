import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import {
  BIOMETRIC_REPROMPT_INTERVAL_MS,
  forgetPromptedBiometricUnlock,
  getBiometricCadence,
  isBiometricPromptDue,
  isPromptDueAt,
  recordPromptedBiometricUnlock,
  setBiometricCadence,
} from './biometricCadence';

const T0 = 1_000_000_000_000;

describe('isPromptDueAt - when a launch must raise the biometric sheet', () => {
  it('always prompts on every_launch, however recent the last proof', () => {
    expect(isPromptDueAt('every_launch', T0, T0 + 1)).toBe(true);
  });

  it('prompts when no proof was ever recorded', () => {
    expect(isPromptDueAt('every_12h', null, T0)).toBe(true);
  });

  it('skips inside the window and prompts from its end on', () => {
    expect(isPromptDueAt('every_12h', T0, T0 + BIOMETRIC_REPROMPT_INTERVAL_MS - 1)).toBe(false);
    expect(isPromptDueAt('every_12h', T0, T0 + BIOMETRIC_REPROMPT_INTERVAL_MS)).toBe(true);
  });

  it('prompts when the clock went backwards - a clock set back must not stretch the window', () => {
    expect(isPromptDueAt('every_12h', T0, T0 - 1)).toBe(true);
  });
});

describe('the stored cadence and its clock', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to every_12h on an empty store, which is how existing installs get it', async () => {
    expect(await getBiometricCadence()).toBe('every_12h');
  });

  it('round-trips every_launch and back', async () => {
    await setBiometricCadence('every_launch');
    expect(await getBiometricCadence()).toBe('every_launch');
    await setBiometricCadence('every_12h');
    expect(await getBiometricCadence()).toBe('every_12h');
  });

  it('skips after a recorded prompted unlock, and prompts again once it is forgotten', async () => {
    recordPromptedBiometricUnlock(T0);
    expect(await isBiometricPromptDue(T0 + 60_000)).toBe(false);
    forgetPromptedBiometricUnlock();
    expect(await isBiometricPromptDue(T0 + 60_000)).toBe(true);
  });

  it('keeps the cadence when the proof is forgotten - disabling biometrics is not a reset', async () => {
    await setBiometricCadence('every_launch');
    forgetPromptedBiometricUnlock();
    expect(await getBiometricCadence()).toBe('every_launch');
  });

  it('treats an unparseable clock as no proof at all', async () => {
    localStorage.setItem('canari_biometric_last_prompted_unlock_at', 'garbage');
    expect(await isBiometricPromptDue(T0)).toBe(true);
  });
});

/**
 * The unattended read crosses four languages with no compiler in between, and the property the
 * user cared most about is that "every time" keeps today's hardware-backed read. Both are pinned
 * here against the sources.
 */
describe('the unattended keystore read, across Rust, Kotlin and Swift', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const PLUGIN_DIR = '../../../src-tauri/patches/tauri-plugin-keystore/';
  const mobileRs = read(`${PLUGIN_DIR}src/mobile.rs`);
  const buildRs = read(`${PLUGIN_DIR}build.rs`);
  const pluginKt = read(`${PLUGIN_DIR}android/src/main/java/KeystorePlugin.kt`);
  const pluginSwift = read(`${PLUGIN_DIR}ios/Sources/KeystorePlugin.swift`);

  /** Body of one Swift method, up to the next method or the end of the class. */
  const swiftMethod = (name: string) => {
    const start = pluginSwift.indexOf(`@objc public func ${name}(`);
    expect(start, `${name} missing from KeystorePlugin.swift`).toBeGreaterThan(-1);
    const next = pluginSwift.indexOf('@objc public func', start + 1);
    return pluginSwift.slice(start, next === -1 ? undefined : next);
  };

  it('names the same native method on every side', () => {
    expect(mobileRs).toContain('run_mobile_plugin("getKeyBytesUnattended"');
    expect(pluginKt).toMatch(/@Command\s+fun getKeyBytesUnattended\(/);
    swiftMethod('getKeyBytesUnattended');
  });

  it('is NOT reachable from JS: it stays out of the command ACL', () => {
    expect(buildRs).not.toContain('unattended');
  });

  it('reads the background item on iOS, with no authentication context', () => {
    const body = swiftMethod('getKeyBytesUnattended');
    expect(body).toContain('"mls_bg_key_\\(args.alias)"');
    expect(body).not.toContain('LAContext');
  });

  it('leaves the prompted iOS read on the .userPresence item behind an LAContext', () => {
    const body = swiftMethod('getKeyBytes');
    expect(body).toContain('"mls_key_\\(args.alias)"');
    expect(body).toContain('kSecUseAuthenticationContext');
  });
});

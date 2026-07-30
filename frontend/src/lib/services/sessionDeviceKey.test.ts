import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Cross-language contract guard for `recuperer_cle_session_mls`, the one command that hands the
 * frontend the at-rest key it never derived.
 *
 * A Tauri command name is an unchecked string on both sides: it compiles, lints and type-checks
 * while resolving to nothing at runtime, and the failure here would be near-invisible - MLS keeps
 * working (Rust holds its own copy of the key), only local message storage silently stops, which
 * is exactly the bug this command was added to fix. So the name, the Rust fn and its registration
 * are pinned to each other.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const mlsRs = read('../../../src-tauri/src/commands/mls.rs');
const libRs = read('../../../src-tauri/src/lib.rs');
const tauriService = read('./TauriMlsService.ts');

/** The single source of truth for the name, as invoked by TauriMlsService. */
const COMMAND = 'recuperer_cle_session_mls';

describe('session device key command contract', () => {
  it('is the name TauriMlsService invokes', () => {
    expect(tauriService).toContain(`invoke<string | null>('${COMMAND}')`);
  });

  it('is defined as a Rust command', () => {
    expect(mlsRs).toMatch(
      new RegExp(`#\\[tauri::command\\]\\s*pub\\(crate\\) async fn ${COMMAND}\\b`)
    );
  });

  it('is imported and registered in generate_handler!', () => {
    // Present in the `use` list but absent from generate_handler! compiles cleanly and still
    // rejects every call at the IPC boundary.
    const handler = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
    expect(handler).toContain(COMMAND);
    expect(libRs).toContain(COMMAND.concat(','));
  });

  it('reads the cached key instead of the keystore, so it raises no second prompt', () => {
    // Reading the keystore again here would put a second BiometricPrompt in the middle of a login
    // that already succeeded. The key must come from the session cache initialiser_mls filled.
    const fn = mlsRs.slice(mlsRs.indexOf(`async fn ${COMMAND}`));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // Whitespace-insensitive: rustfmt splits the field access across lines.
    expect(body).toMatch(/state\s*\.device_key/);
    expect(body).not.toContain('retrieve_device_key');
    expect(body).not.toContain('PluginDeviceKeyStore');
  });
});

describe('biometric login pulls the key into the session', () => {
  const sessionAuth = read('../composables/session/sessionAuth.ts');

  /**
   * The block that pulls the key in, anchored on the resolve call itself - `if (isBiometric)`
   * appears earlier in loginImpl for the log line, and anchoring there would silently widen the
   * slice over unrelated code.
   */
  const biometricKeyBlock = () => {
    const start = sessionAuth.indexOf('await mlsService.resolveSessionDeviceKey()');
    const end = sessionAuth.indexOf('ctx.setStorage(storageSettled.value)');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return sessionAuth.slice(start, end);
  };

  it('resolves the session device key on the biometric path', () => {
    expect(sessionAuth).toContain('await mlsService.resolveSessionDeviceKey()');
  });

  it('stores it in the session context, and only there', () => {
    // ctx.setDeviceKey feeds every local-message crypto call site. The local `deviceKeyB64` must
    // stay empty: it gates the device-key vault write and store_push_context, both of which
    // biometric mode must keep skipped.
    const block = biometricKeyBlock();
    expect(block).toContain('ctx.setDeviceKey(sessionKey)');
    expect(block).not.toContain('deviceKeyB64 = sessionKey');
  });

  it('fails the login rather than continuing with no key', () => {
    // Continuing means a whole session whose messages are never persisted, with nothing in the
    // log. Failing sends the user to the PIN modal, which derives a working key.
    const block = biometricKeyBlock();
    expect(block).toContain("new LoginFailure('keystore_empty'");
  });
});

describe('the biometric entry point clears the login guard', () => {
  const backgroundService = read('../components/layout/ChatBackgroundService.svelte');

  it('hands the flag over to loginImpl before calling biometricLogin', () => {
    // startLoginFlow raises isLoginInProgress for the +layout.ts guard, and loginImpl bails when
    // it is set - it cannot tell that flag from a real concurrent login. Leaving it set swallowed
    // the automatic biometric attempt of every cold launch.
    const call = backgroundService.indexOf('globalSession.biometricLogin({');
    expect(call).toBeGreaterThan(-1);
    const preceding = backgroundService.slice(0, call);
    const lastRelease = preceding.lastIndexOf('globalSession.isLoginInProgress = false;');
    // The release must be the statement immediately before the call, comments aside.
    expect(preceding.slice(lastRelease).replace(/\/\/[^\n]*\n|\s/g, '')).toBe(
      'globalSession.isLoginInProgress=false;await'
    );
  });
});

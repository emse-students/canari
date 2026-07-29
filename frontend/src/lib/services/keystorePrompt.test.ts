import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keystoreUnlockPrompt } from './biometric';

/**
 * Cross-language contract guard for the keystore unlock sheet.
 *
 * The text of that sheet is assembled in TypeScript, serialized into `GetKeyBytesRequest`, and
 * consumed by Kotlin and Swift - four languages, no compiler in between. Every failure mode here
 * is silent: a field renamed on one side simply arrives as null, the native code takes its French
 * fallback, and an English user gets a French prompt with nothing logged. Same class of defect as
 * `push_context.json` (see pushContextFields.test.ts), same kind of guard.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PLUGIN_DIR = '../../../src-tauri/patches/tauri-plugin-keystore/';
const modelsRs = read(`${PLUGIN_DIR}src/models.rs`);
const pluginKt = read(`${PLUGIN_DIR}android/src/main/java/KeystorePlugin.kt`);
const pluginSwift = read(`${PLUGIN_DIR}ios/Sources/KeystorePlugin.swift`);

/** camelCase -> snake_case, the Rust field name behind `#[serde(rename_all = "camelCase")]`. */
const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Body of the Kotlin/Swift `GetKeyBytesRequest` declaration, so a match cannot come from elsewhere. */
function requestBody(source: string, open: RegExp): string {
  const start = source.search(open);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('}', start);
  return source.slice(start, end);
}

const promptFields = Object.keys(keystoreUnlockPrompt());

describe('keystore unlock prompt', () => {
  it('fills every field the native side can display', () => {
    // A blank value is as bad as a missing one: the sheet would show an empty title.
    for (const [field, value] of Object.entries(keystoreUnlockPrompt())) {
      expect(value, field).toBeTruthy();
    }
  });

  it('names every field in the Rust request model', () => {
    const body = requestBody(modelsRs, /pub struct BiometricPromptText \{/);
    for (const field of promptFields) {
      expect(body, field).toContain(`pub ${toSnake(field)}: Option<String>`);
    }
  });

  it('decodes on Android every field Android can show', () => {
    // `reason` is deliberately absent: BiometricPrompt has no equivalent of LAContext's
    // localizedReason, so Android would have nowhere to put it.
    const body = requestBody(pluginKt, /class GetKeyBytesRequest \{/);
    for (const field of ['title', 'subtitle', 'cancelTitle']) {
      expect(body, field).toContain(`var ${field}: String? = null`);
    }
  });

  it('decodes on iOS every field of the contract', () => {
    const body = requestBody(pluginSwift, /class GetKeyBytesRequest: Decodable \{/);
    for (const field of promptFields) {
      expect(body, field).toContain(`let ${field}: String?`);
    }
  });

  it('prefers the supplied text over the native fallback', () => {
    // The regression this pins: reading the fields but still building the prompt from literals.
    expect(pluginKt).toContain('.setTitle(args.title ?: DEFAULT_UNLOCK_TITLE)');
    expect(pluginKt).toContain('.setSubtitle(args.subtitle ?: DEFAULT_UNLOCK_SUBTITLE)');
    expect(pluginKt).toContain('.setNegativeButtonText(args.cancelTitle ?: DEFAULT_CANCEL)');
    expect(pluginSwift).toContain('context.localizedReason = args.reason ?? kBiometricReason');
    expect(pluginSwift).toContain('context.localizedCancelTitle = cancelTitle');
  });
});

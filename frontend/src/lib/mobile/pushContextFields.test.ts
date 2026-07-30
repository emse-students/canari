import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Push-context contract guardrail.
 *
 * `store_push_context` (push.rs) writes push_context.json. Three native background readers
 * parse that same file:
 *   - ObjC:   canari_push.mm            `CanariLoadPushContext`
 *   - Swift:  NotificationService.swift `loadPushContext`
 *   - Kotlin: MlsContextLoader.kt       `loadPushContext`
 *
 * Nothing type-checks across that boundary - the contract is a JSON string key on one side
 * and a string literal on three others. Renaming a field on the Rust side compiles, lints and
 * ships, then fails at runtime. That exact regression shipped in v0.11.0: `pin` was renamed to
 * `deviceKeyB64` in Rust but not on iOS, so `CanariLoadPushContext` returned nil on every call
 * and the NSE served the generic fallback for every push until WP-IOS-1.
 *
 * Since WP-SEC-1 the device key is NOT in this JSON at all - it lives in the platform keystore
 * (Android Keystore / iOS Keychain), and each reader sources it there. So this file asserts two
 * things: the JSON key sets still line up, and no reader has drifted back to reading the key
 * out of the file.
 */
const here = dirname(fileURLToPath(import.meta.url));

const PUSH_RS = resolve(here, '../../../src-tauri/src/commands/push.rs');
const CANARI_PUSH_MM = resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_push.mm');
const CANARI_IOS_MM = resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm');
const NOTIF_SERVICE_SWIFT = resolve(
  here,
  '../../../src-tauri/gen/apple/canari_NSE/NotificationService.swift'
);
const MLS_CONTEXT_LOADER_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsContextLoader.kt'
);
const CANARI_APPLICATION_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariApplication.kt'
);
const KEYSTORE_PLUGIN_SWIFT = resolve(
  here,
  '../../../src-tauri/patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift'
);
const MLS_DEVICE_KEY_STORE_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/MlsDeviceKeyStore.kt'
);
const KEYSTORE_PLUGIN_KT = resolve(
  here,
  '../../../src-tauri/patches/tauri-plugin-keystore/android/src/main/java/KeystorePlugin.kt'
);

/** Unique, sorted capture group 1 of every match of `regex` in `source`. */
function extractKeys(source: string, regex: RegExp): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(regex)) keys.add(match[1]);
  return [...keys].sort();
}

/**
 * Slices out a single function body so a reader's JSON keys are not confused with the other
 * JSON payloads the same file handles (cache, outbox, commits).
 */
function functionBody(source: string, startPattern: RegExp, endPattern: RegExp): string {
  const start = source.search(startPattern);
  if (start < 0) throw new Error(`function start not found: ${startPattern}`);
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  if (end < 0) throw new Error(`function end not found: ${endPattern}`);
  return rest.slice(0, end);
}

describe('push_context.json contract (Rust writer vs 3 native readers)', () => {
  const rustSource = readFileSync(PUSH_RS, 'utf8');
  const objcSource = readFileSync(CANARI_PUSH_MM, 'utf8');
  const iosAppSource = readFileSync(CANARI_IOS_MM, 'utf8');
  const swiftSource = readFileSync(NOTIF_SERVICE_SWIFT, 'utf8');
  const kotlinSource = readFileSync(MLS_CONTEXT_LOADER_KT, 'utf8');
  const kotlinAppSource = readFileSync(CANARI_APPLICATION_KT, 'utf8');

  // Keys written by store_push_context.
  const rustJsonBlock = functionBody(
    rustSource,
    /fn store_push_context/,
    /std::fs::write\(data_dir\.join\("push_context\.json"\)/
  );
  const rustKeys = extractKeys(rustJsonBlock, /"(\w+)"\s*:/g);

  // Keys each reader pulls out of the file, scoped to the reader function.
  const objcKeys = extractKeys(
    functionBody(objcSource, /static CanariPushContext \*_Nullable CanariLoadPushContext/, /\n}/),
    /dict\[@"(\w+)"\]/g
  );
  const swiftKeys = extractKeys(
    functionBody(swiftSource, /private func loadPushContext\(\)/, /\n  }/),
    /json\["(\w+)"\]/g
  );
  const kotlinKeys = extractKeys(
    functionBody(kotlinSource, /fun loadPushContext\(context: Context\)/, /\n    }/),
    /\.optString\("(\w+)"/g
  );

  it('writes the fields it is expected to write', () => {
    expect(rustKeys).toEqual(['baseUrl', 'deviceId', 'pushToken', 'userId']);
  });

  it.each([
    ['canari_push.mm', () => objcKeys],
    ['NotificationService.swift', () => swiftKeys],
    ['MlsContextLoader.kt', () => kotlinKeys],
  ])('%s only reads keys that push.rs actually writes', (_name, keys) => {
    for (const key of keys()) expect(rustKeys).toContain(key);
  });

  it.each([
    ['canari_push.mm', () => objcKeys],
    ['NotificationService.swift', () => swiftKeys],
    ['MlsContextLoader.kt', () => kotlinKeys],
  ])('%s requires userId + deviceId + baseUrl', (_name, keys) => {
    expect(keys()).toEqual(expect.arrayContaining(['userId', 'deviceId', 'baseUrl']));
  });

  // WP-SEC-1: the key is keystore-only. WP-IOS-1: "pin" is dead everywhere.
  it.each([
    ['push.rs', () => rustKeys],
    ['canari_push.mm', () => objcKeys],
    ['NotificationService.swift', () => swiftKeys],
    ['MlsContextLoader.kt', () => kotlinKeys],
  ])('%s carries neither the device key nor the legacy "pin" in the JSON', (_name, keys) => {
    expect(keys()).not.toContain('deviceKeyB64');
    expect(keys()).not.toContain('pin');
  });

  it.each([
    ['canari_push.mm', () => objcSource, /CanariRetrieveDeviceKey\(userId, deviceId\)/],
    [
      'NotificationService.swift',
      () => swiftSource,
      /Self\.retrieveDeviceKey\(userId: userId, deviceId: deviceId\)/,
    ],
    [
      'MlsContextLoader.kt',
      () => kotlinSource,
      /MlsDeviceKeyStore\.retrieve\(context, userId, deviceId\)/,
    ],
  ])('%s sources the device key from the platform keystore', (_name, source, pattern) => {
    expect(source()).toMatch(pattern);
  });

  // The upgrade path off v0.11.x: without these, an existing install has its key only in the
  // old JSON, nothing ever promotes it, and background decrypt stays dead forever.
  it.each([
    ['canari_ios.mm', () => iosAppSource, /CanariMigrateDeviceKeyFromJson/],
    ['CanariApplication.kt', () => kotlinAppSource, /migrateDeviceKeyFromJson/],
  ])('%s still runs the one-shot legacy key migration', (_name, source, pattern) => {
    expect(source()).toMatch(pattern);
  });
});

/**
 * Keystore encoding contract.
 *
 * The device key crosses the keystore boundary as RAW 32 bytes but crosses the FFI boundary as
 * base64 text, and five files in three languages have to agree on where the conversion happens.
 * Nothing checks it: every side compiles whichever it picks. Two variants of this exact mismatch
 * were caught in review of WP-SEC-1 - Android returning `Base64.DEFAULT` (whose trailing newline
 * the Rust `decode_base64_to_32_bytes` does not trim), and both iOS readers UTF-8-decoding raw
 * key bytes, which yields nothing for almost every key. Both fail silently, as a generic push.
 *
 * Writers base64-DECODE before storing; readers base64-ENCODE after loading.
 *
 * Android has TWO readers over the same alias and the same SharedPreferences: `MlsDeviceKeyStore`
 * (background, Context-only) and `KeystorePlugin.getKeyBytes` (foreground, behind the
 * BiometricPrompt). Only the first was asserted here, so the `Base64.DEFAULT` newline survived in
 * the second until v0.11.5 - a successful fingerprint decrypted the key, Rust rejected the string,
 * and the login reported an empty keystore. Both readers are covered now: a fix to one of these
 * twins that is not applied to the other is the shape this file exists to catch.
 */
describe('device key keystore encoding (raw bytes at rest, base64 on the wire)', () => {
  const keystoreSwift = readFileSync(KEYSTORE_PLUGIN_SWIFT, 'utf8');
  const keystoreKt = readFileSync(KEYSTORE_PLUGIN_KT, 'utf8');
  const deviceKeyStoreKt = readFileSync(MLS_DEVICE_KEY_STORE_KT, 'utf8');
  const objcSource = readFileSync(CANARI_PUSH_MM, 'utf8');
  const iosAppSource = readFileSync(CANARI_IOS_MM, 'utf8');
  const swiftSource = readFileSync(NOTIF_SERVICE_SWIFT, 'utf8');

  const storeKeyBytes = functionBody(keystoreSwift, /@objc public func storeKeyBytes/, /\n {2}}/);
  const objcRetrieve = functionBody(
    objcSource,
    /static NSString \*_Nullable CanariRetrieveDeviceKey/,
    /\n}/
  );
  const swiftRetrieve = functionBody(
    swiftSource,
    /private static func retrieveDeviceKey/,
    /\n {2}}/
  );
  const iosMigration = functionBody(
    iosAppSource,
    /static void CanariMigrateDeviceKeyFromJson/,
    /\n}/
  );
  const ktStore = functionBody(deviceKeyStoreKt, /fun store\(/, /\n {4}}/);
  const ktRetrieve = functionBody(deviceKeyStoreKt, /fun retrieve\(/, /\n {4}}/);
  const ktPluginStore = functionBody(keystoreKt, /fun storeKeyBytes\(/, /\n {4}}/);
  const ktPluginGet = functionBody(keystoreKt, /fun getKeyBytes\(/, /\n {4}}/);

  it.each([
    ['KeystorePlugin.storeKeyBytes (iOS login)', () => storeKeyBytes, /Data\(base64Encoded:/],
    [
      'CanariMigrateDeviceKeyFromJson (iOS upgrade)',
      () => iosMigration,
      /initWithBase64EncodedString/,
    ],
    ['MlsDeviceKeyStore.store (Android)', () => ktStore, /Base64\.decode\(keyB64/],
    [
      'KeystorePlugin.storeKeyBytes (Android login)',
      () => ktPluginStore,
      /Base64\.decode\(args\.keyBytes/,
    ],
  ])('%s decodes base64 into raw bytes before storing', (_name, body, pattern) => {
    expect(body()).toMatch(pattern);
  });

  it.each([
    ['CanariRetrieveDeviceKey', () => objcRetrieve, /base64EncodedStringWithOptions/],
    ['NotificationService.retrieveDeviceKey', () => swiftRetrieve, /base64EncodedString\(\)/],
  ])('%s re-encodes the raw bytes as base64', (_name, body, pattern) => {
    expect(body()).toMatch(pattern);
  });

  it.each([
    ['CanariRetrieveDeviceKey', () => objcRetrieve, /NSUTF8StringEncoding/],
    ['NotificationService.retrieveDeviceKey', () => swiftRetrieve, /String\(data:/],
    ['CanariMigrateDeviceKeyFromJson', () => iosMigration, /dataUsingEncoding:/],
  ])('%s does not treat the raw key bytes as UTF-8 text', (_name, body, pattern) => {
    expect(body()).not.toMatch(pattern);
  });

  // DEFAULT appends a newline and decode_base64_to_32_bytes does not trim. Both Android readers
  // hand their result to Rust, so both must use NO_WRAP - the assertion is per reader because
  // fixing one twin and leaving the other is precisely how this shipped twice.
  it.each([
    ['MlsDeviceKeyStore.retrieve (background)', () => ktRetrieve, 'decrypted'],
    ['KeystorePlugin.getKeyBytes (foreground)', () => ktPluginGet, 'decryptedBytes'],
  ])('%s returns NO_WRAP base64, never DEFAULT', (_name, body, variable) => {
    // Captures the flag rather than asserting NO_WRAP is present: matching the literal would
    // still pass if a second, DEFAULT-flagged encode of the same value were added beside it.
    const encode = new RegExp(`Base64\\.encodeToString\\(${variable}, Base64\\.(\\w+)\\)`);
    expect(body()).toMatch(encode);
    expect(body().match(encode)?.[1]).toBe('NO_WRAP');
  });
});

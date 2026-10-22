import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The native half of the owner's new-device alert (user decision 2026-10-22) crosses Rust, Kotlin,
 * Objective-C headers and Swift, and only CI compiles the phone builds - so the seams are pinned
 * here, read from source: the ledger claim has ONE implementation reached through a JNI symbol and
 * a C symbol that must match their callers, and every native answer that may carry
 * `ownDeviceAdded` is read by the announcing function.
 */
const here = dirname(fileURLToPath(import.meta.url));
const tauri = resolve(here, '../../../src-tauri');
const read = (p: string) => readFileSync(resolve(tauri, p), 'utf8');

const kotlin = read(
  'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);
const libRs = read('src/lib.rs');
const iosFfi = read('src/mobile/ios_ffi.rs');
const header = read('gen/apple/canari_NSE/canari_mls_ffi.h');
const swift = read('gen/apple/canari_NSE/NotificationService.swift');

describe('new-device notice - the native seams', () => {
  it('Android: the JNI symbol matches the external fun, and both answers are announced', () => {
    expect(libRs).toContain(
      'Java_fr_emse_canari_CanariFirebaseMessagingService_nativeClaimDeviceNotices'
    );
    expect(kotlin).toMatch(
      /external fun nativeClaimDeviceNotices\(dataDir: String, keysJson: String\): String/
    );
    // The one reader of every push-decrypt answer announces, and so does the background Add.
    const parse = kotlin.slice(kotlin.indexOf('private fun parseNativeDecrypt('));
    expect(parse.slice(0, 400)).toContain('announceOwnDevicesAdded(json, where)');
    expect(kotlin).toContain('announceOwnDevicesAdded(result, "processWelcomeRequestBackground")');
    expect(kotlin).toContain('R.string.notif_new_device_body');
  });

  it('iOS: the C symbol is defined, declared, and called by both decrypt paths', () => {
    expect(iosFfi).toContain('pub unsafe extern "C" fn canari_native_claim_device_notices(');
    expect(header).toContain(
      'char *canari_native_claim_device_notices(const char *data_dir, const char *keys_json);'
    );
    expect(swift).toContain('canari_native_claim_device_notices(dir.path, keysJson)');
    expect(swift).toContain('announceOwnDevicesAdded(json, ctx: ctx, where: "decrypt")');
    expect(swift).toContain('announceOwnDevicesAdded(json, ctx: ctx, where: "catchup")');
  });

  it('both NSE tables carry the two strings the extension reads', () => {
    for (const lang of ['fr', 'en']) {
      const table = read(`gen/apple/canari_NSE/${lang}.lproj/Localizable.strings`);
      expect(table).toContain('"notif.device.added.title"');
      expect(table).toContain('"notif.device.added.body"');
    }
  });
});

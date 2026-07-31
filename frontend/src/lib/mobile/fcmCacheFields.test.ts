import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * FCM message cache contract guardrail.
 *
 * `fcm_message_cache.ndjson` is written by two native writers and read by one Rust reader:
 *   - Kotlin: CanariFirebaseMessagingService.writeFcmCache
 *   - Swift:  NotificationService.writeFcmCache
 *   - Rust:   read_and_clear_fcm_cache (push.rs)
 *
 * The file is an unframed newline-delimited JSON stream. Any drift in field names, missing
 * fields, or encoding differences between Android and iOS will only surface at runtime when
 * the TS consumer imports a malformed preview. WP-PUSH-2 added the iOS writer; this test
 * makes sure it stays byte-for-byte compatible with the Android writer and the Rust reader.
 */
const here = dirname(fileURLToPath(import.meta.url));

const CANARI_FIREBASE_SERVICE_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);
const NOTIF_SERVICE_SWIFT = resolve(
  here,
  '../../../src-tauri/gen/apple/canari_NSE/NotificationService.swift'
);
const PUSH_RS = resolve(here, '../../../src-tauri/src/commands/push.rs');
const FCM_CACHE_TS = resolve(here, '../utils/chat/fcmCache.ts');

/** Unique, sorted capture group 1 of every match of `regex` in `source`. */
function extractKeys(source: string, regex: RegExp): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(regex)) keys.add(match[1]);
  return [...keys].sort();
}

/**
 * Slices out a single function body so a writer's JSON keys are not confused with the other
 * JSON payloads the same file handles (push context, outbox, commits).
 */
function functionBody(source: string, startPattern: RegExp, endPattern: RegExp): string {
  const start = source.search(startPattern);
  if (start < 0) throw new Error(`function start not found: ${startPattern}`);
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  if (end < 0) throw new Error(`function end not found: ${endPattern}`);
  return rest.slice(0, end);
}

describe('fcm_message_cache.ndjson contract (Android + iOS writers vs Rust reader)', () => {
  const kotlinSource = readFileSync(CANARI_FIREBASE_SERVICE_KT, 'utf8');
  const swiftSource = readFileSync(NOTIF_SERVICE_SWIFT, 'utf8');
  const rustSource = readFileSync(PUSH_RS, 'utf8');

  const kotlinWriteBody = functionBody(
    kotlinSource,
    /private fun writeFcmCache\(/,
    /\n\n    \/\/ --- Avatar/
  );

  const swiftWriteBlock = functionBody(
    swiftSource,
    /private func writeFcmCache\(/,
    /\n  }\n\n  \/\/ MARK: - Backend fetches/
  );

  it('both native writers include the same mandatory fields', () => {
    const kotlinKeys = extractKeys(kotlinWriteBody, /put\("(\w+)"\s*,/g);
    const swiftKeys = extractKeys(swiftWriteBlock, /"(\w+)"\s*:/g);
    const mandatory = [
      'groupId',
      'messageId',
      'senderId',
      'senderName',
      'content',
      'timestamp',
      'type',
    ];
    for (const key of mandatory) {
      expect(kotlinKeys).toContain(key);
      expect(swiftKeys).toContain(key);
    }
  });

  it('both native writers include the same optional fields', () => {
    const kotlinKeys = extractKeys(kotlinWriteBody, /put\("(\w+)"\s*,/g);
    // Swift sets optional keys via `entry["<key>"] = ...`, not in the literal declaration.
    const swiftKeys = extractKeys(swiftWriteBlock, /entry\["(\w+)"\]/g);
    const optional = ['replyTo', 'mediaKind'];
    for (const key of optional) {
      expect(kotlinKeys).toContain(key);
      expect(swiftKeys).toContain(key);
    }
  });

  it('both writers cap the cache at 50 entries', () => {
    expect(kotlinSource).toMatch(/MAX_FCM_CACHE_ENTRIES\s*=\s*50/);
    // Swift declaration uses `maxFcmCacheEntries = 50` as a static constant.
    expect(swiftSource).toMatch(/maxFcmCacheEntries\s*=\s*50/);
  });

  it('the Rust reader consumes the same file name', () => {
    expect(rustSource).toMatch(/fcm_message_cache\.ndjson/);
  });

  it('the iOS writer targets the App Group, and the app drains it into its own container', () => {
    // An app extension has its own data container: `applicationSupportDirectory` inside the NSE
    // is NOT the app's `app_data_dir`, so writing there produces a file nothing ever reads. The
    // App Group is the only storage the two processes share, and something on the app side has
    // to carry the entries over. Neither half is checkable from anywhere but this test off macOS.
    const nseWrite = functionBody(
      swiftSource,
      /private func writeFcmCache\(/,
      /\n  }\n\n  \/\/ MARK: - Backend fetches/
    );
    expect(nseWrite).toContain('appGroupDir()');
    expect(nseWrite).not.toContain('applicationSupportDirectory');

    const pushMm = readFileSync(
      resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_push.mm'),
      'utf8'
    );
    expect(pushMm).toMatch(/void CanariDrainAppGroupFcmCache\(void\)/);
    const iosMm = readFileSync(
      resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm'),
      'utf8'
    );
    expect(iosMm).toContain('CanariDrainAppGroupFcmCache()');
  });

  it('the TypeScript consumer expects the same field set', () => {
    const tsSource = readFileSync(FCM_CACHE_TS, 'utf8');
    const block = functionBody(tsSource, /interface FcmCacheEntry/, /}\s*\n\n/);
    const tsKeys = extractKeys(block, /(\w+)\??:/g);
    const mandatory = [
      'groupId',
      'messageId',
      'senderId',
      'senderName',
      'content',
      'timestamp',
      'type',
    ];
    for (const key of mandatory) {
      expect(tsKeys).toContain(key);
    }
    expect(tsKeys).toContain('replyTo');
    expect(tsKeys).toContain('mediaKind');
  });
});

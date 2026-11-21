import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE MIRROR'S OWNERSHIP, NATIVE WIRING (P1 `p1-a-warm-page-erases-the-native-only-outbox-entries`,
 * 2026-11-21).
 *
 * The merge rule is `outbox_mirror.rs`'s, tested by cargo; the page's half is
 * `outboxMirror.ownership.test.ts`. What neither can see is held here: that the page's write takes
 * the SAME monitor the Kotlin writers take, and that no native rewrite drops the `owner` stamp - a
 * page line rewritten without it reads as native, and outlives the page's own settlement of it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(HERE, '../../../src-tauri', path), 'utf8');
const fcm = read('gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt');
const ios = read('gen/apple/Sources/canari/canari_push.mm');
const rust = read('src/commands/outbox_mirror.rs');
const bridge = read('gen/apple/Sources/canari/canari_rust_bridge.h');

describe('the outbox mirror - one lock, and the owner survives every native rewrite', () => {
  it('Kotlin hands its OUTBOX_LOCK to the page, static, and Rust takes that monitor', () => {
    expect(fcm).toMatch(/@JvmStatic\s+fun outboxLock\(\): Any = OUTBOX_LOCK/);
    expect(rust).toContain('"outboxLock", "()Ljava/lang/Object;"');
    expect(rust).toContain('env.lock_obj(&lock)');
  });

  it('both page commands touch the file under that lock only', () => {
    expect(rust).toContain('under_outbox_lock(|| write_page_lines(');
    expect(rust).toContain('under_outbox_lock(|| read_text(');
  });

  it('Kotlin reads and rewrites the owner', () => {
    expect(fcm).toContain('o.optString("owner").takeIf { it.isNotEmpty() }');
    expect(fcm).toContain('e.owner?.let { put("owner", it) }');
  });

  // The iOS twin of the JNI monitor: the page's commands and canari_push.mm share ONE lock in the app
  // process (the notification extension never names the file, which lives outside its reach).
  it('iOS takes the lock the page takes around every read-modify-write of the mirror', () => {
    expect(bridge).toContain(
      'void canari_with_outbox_mirror_lock(void *ctx, void (*work)(void *ctx));'
    );
    expect(rust).toMatch(
      /#\[cfg\(target_os = "ios"\)\]\s+fn under_outbox_lock[^]*?with_mirror_lock\(work\)/
    );
    // Every read and rewrite of the file sits in a function that runs under the lock: the locked
    // drain, or an append inside `CanariWithOutboxMirrorLock(^{ ... })`.
    const reads = ios.split('CanariReadOutboxMirror()').length - 1;
    const appends =
      ios.match(
        /CanariWithOutboxMirrorLock\(\^\{\s+NSMutableArray<CanariOutboxEntry \*> \*entries = \[CanariReadOutboxMirror\(\) mutableCopy\];\s+\[entries addObject:entry\];\s+CanariRewriteOutboxMirror\(entries\);\s+\}\);/g
      ) ?? [];
    expect(appends).toHaveLength(2);
    const definition = ios.search(/static int CanariDrainOutboxBackgroundLocked\([^;{]*\)\s*\{/);
    expect(definition).toBeGreaterThan(-1);
    expect(ios.slice(definition, definition + 400)).toContain('CanariReadOutboxMirror()');
    expect(reads).toBe(appends.length + 1);
    expect(ios).toContain('remaining = CanariDrainOutboxBackgroundLocked(ctx, receivedAtOut);');
  });

  it('iOS rewrites a line from the line it read, so owner and unsendable survive', () => {
    expect(ios).toContain('entry.fields = o;');
    expect(ios).toContain('[e.fields mutableCopy]');
  });
});

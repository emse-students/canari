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

  it('both page commands touch the file under that lock only, folding the journal first', () => {
    expect(rust).toMatch(
      /under_outbox_lock\(\|\| \{\s+let fold = fold_into_mirror\(&data_dir\)\?;\s+Ok::<_, String>\(\(fold, write_page_lines\(/
    );
    expect(rust).toMatch(
      /under_outbox_lock\(\|\| \{\s+let fold = fold_into_mirror\(&data_dir\)\?;\s+Ok::<_, String>\(\(fold, read_text\(/
    );
  });

  // Review of #3929: a drain holds the lock through its POSTs, and a shade reply that waited for it
  // sat in memory only. The append goes to a journal under its own short lock, never the mirror's.
  it('a native append never takes the mirror lock: it goes to the journal, folded by a drain', () => {
    // Kotlin: the append is the JNI journal door, and the drain folds before it reads.
    const enqueue = fcm.slice(fcm.indexOf('internal fun enqueueOutboxMirror('));
    expect(enqueue.slice(0, 400)).toContain('nativeAppendOutboxJournal(dir, outboxLineJson(entry)');
    expect(enqueue.slice(0, 400)).not.toContain('OUTBOX_LOCK');
    expect(fcm).toMatch(
      /foldOutboxJournalLocked\(context, "drainOutbox"\)\s+val mirror = readOutboxMirror\(context\)/
    );
    expect(rust).toContain(
      'Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeAppendOutboxJournal'
    );
    expect(rust).toContain(
      'Java_fr_emse_canari_CanariFirebaseMessagingService_00024Companion_nativeFoldOutboxMirror'
    );
    // iOS: the same two doors, declared, and the drain folds before it reads.
    expect(bridge).toContain(
      'int canari_outbox_journal_append(const char *data_dir, const char *line);'
    );
    expect(bridge).toContain('int canari_outbox_fold(const char *data_dir);');
    expect(ios.match(/if \(!CanariAppendOutboxJournal\(entry\)\)/g) ?? []).toHaveLength(2);
    // The journal lock covers the file write only: nothing under it takes the mirror lock.
    const append = rust.slice(rust.indexOf('pub(crate) fn append_journal('));
    expect(append.slice(0, 1200)).not.toContain('under_outbox_lock');
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
    // The ONE read of the file is the locked drain's, after its fold; the appends go to the journal.
    const reads = ios.split('CanariReadOutboxMirror()').length - 1;
    const definition = ios.search(/static int CanariDrainOutboxBackgroundLocked\([^;{]*\)\s*\{/);
    expect(definition).toBeGreaterThan(-1);
    expect(ios.slice(definition, definition + 800)).toMatch(
      /canari_outbox_fold\(foldDir\.UTF8String\)[^]*?CanariReadOutboxMirror\(\)/
    );
    expect(reads).toBe(1);
    expect(ios).toContain('remaining = CanariDrainOutboxBackgroundLocked(ctx, receivedAtOut);');
  });

  // Review of #3929: an ObjC exception must never unwind through the Rust frame holding the lock.
  it('iOS runs the locked work inside @try, so no exception crosses the Rust frame', () => {
    const trampoline = ios.slice(ios.indexOf('static void CanariOutboxMirrorLockTrampoline('));
    expect(trampoline.slice(0, 500)).toMatch(
      /@try \{\s+work\(\);\s+\} @catch \(NSException \*exception\)/
    );
  });

  it('iOS rewrites a line from the line it read, so owner and unsendable survive', () => {
    expect(ios).toContain('entry.fields = o;');
    expect(ios).toContain('[e.fields mutableCopy]');
  });
});

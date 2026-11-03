import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE iOS ACTIVATION MIRROR COPIES `mls.bin` THROUGH RUST, UNDER THE STATE FILES' LOCK (re-review of
 * #2919, one MLS state per account). An account switch moves the slot and refreshes the App Group
 * copy inside `mls_bin_write_lock`; a mirror copying the file itself, with no lock, could write the
 * previous account's state over that refresh. No CI compiles the Objective-C, so this reads the
 * sources: the codes agree across the C header and Rust, and the mirror never copies `mls.bin` on its
 * own again.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../src-tauri');
const read = (path: string) => readFileSync(path, 'utf8');

const header = read(resolve(TAURI, 'gen/apple/Sources/canari/canari_rust_bridge.h'));
const push = read(resolve(TAURI, 'gen/apple/Sources/canari/canari_push.mm'));
const rust = read(resolve(TAURI, 'src/commands/mls_account_state.rs'));

describe('the iOS activation mirror of mls.bin', () => {
  it('answers in codes the header and Rust spell the same way', () => {
    const names = [...rust.matchAll(/const MIRROR_(\w+): i32 = ([^;]+);/g)];
    expect(names.map((m) => m[1]).sort()).toEqual(['FAILED', 'NO_DIR', 'NO_GROUP', 'OK']);
    for (const [, name, value] of names) {
      const define = new RegExp(`#define CANARI_MLS_MIRROR_${name} \\(?([^)\\n]+)\\)?\\n`).exec(
        header
      );
      expect(define, name).not.toBeNull();
      expect(Number(define![1]), name).toBe(Number(value));
    }
    expect(header).toContain('int canari_ios_mirror_mls_bin_to_app_group(const char *data_dir);');
    expect(rust).toContain('pub unsafe extern "C" fn canari_ios_mirror_mls_bin_to_app_group(');
  });

  it('hands mls.bin to Rust and copies only the other inputs itself', () => {
    const start = push.indexOf('void CanariMirrorPushStateToAppGroup(void) {');
    const body = push.slice(start, push.indexOf('\n}\n', start));
    expect(body).toContain('canari_ios_mirror_mls_bin_to_app_group(src.UTF8String)');
    expect(body).toContain(
      'for (NSString *name in @[ kPushContextFileName, kGraineSeedsFileName ])'
    );
    expect(body).not.toMatch(/@\[[^\]]*kMlsBinFileName/);
  });
});

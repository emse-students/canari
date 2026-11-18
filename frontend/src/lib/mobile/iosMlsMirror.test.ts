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

  it('hands mls.bin to Rust and copies no seed mirror at all', () => {
    const start = push.indexOf('void CanariMirrorPushStateToAppGroup(void) {');
    const body = push.slice(start, push.indexOf('\n}\n', start));
    expect(body).toContain('canari_ios_mirror_mls_bin_to_app_group(src.UTF8String)');
    expect(body).not.toMatch(/@\[[^\]]*kMlsBinFileName/);
    // THE SEED MIRROR IS NOT COPIED (2026-11-17, channel-encryption section 27): the byte copy made
    // here erased every seed the extension had stored while the app was shut, and the next push of
    // that session drew the generic banner. The file lives in the App Group, written by both.
    expect(body).not.toMatch(/graine_seeds_to_app_group|kGraineSeedsFileName/);
    expect(header).not.toContain('canari_ios_mirror_graine_seeds_to_app_group');
  });
});

/**
 * ONE SEED MIRROR ON iOS, IN THE APP GROUP (2026-11-17, channel-encryption section 27). Two copies -
 * the app's and the extension's - were reconciled by a lifecycle byte copy that let the app's win,
 * so a seed the extension opened from a frame was erased the moment the app came to the foreground.
 * The foreground now writes the App Group's file (`seed_mirror_home`) and the app-alive push path
 * reads it there; no CI compiles the Objective-C, so this reads the sources.
 */
describe('the iOS seed mirror', () => {
  const pushRs = read(resolve(TAURI, 'src/commands/push.rs'));

  it('is written by the foreground in the App Group, after deleting the app copy an older build left', () => {
    const appMirror = pushRs.slice(pushRs.indexOf('async fn with_app_mirror<'));
    const body = appMirror.slice(0, appMirror.indexOf('\n}\n'));
    expect(body).toContain('let home = seed_mirror_home(&data_dir, &key)?;');
    // Background time held BEFORE any App Group lock is taken (the edit takes one):
    // an app suspended holding a shared-container lock is killed, 0xdead10cc.
    const held = body.indexOf('crate::app_group::BackgroundTime::begin(');
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(body.indexOf('seed_mirror_home(&data_dir, &key)'));
    expect(body).toContain('edit(&home, &key)');
    const home = pushRs.slice(pushRs.indexOf('fn seed_mirror_home('));
    const homeBody = home.slice(0, home.indexOf('\n}\n'));
    expect(homeBody).toContain('crate::app_group::app_group_dir()');
    // The former app copy is deleted unread since the floor reached 1.7.0 (legacy-compatibility).
    expect(homeBody).toContain('remove_graine_mirror(data_dir)');
    expect(pushRs).not.toContain('fn fold_legacy_seed_mirror(');
    expect(pushRs).not.toContain('fn sync_seed_mirror_copy(');
  });

  it('is read by the app-alive push path in the App Group', () => {
    for (const fn of [
      'static BOOL CanariGraineSeedHeld(',
      'static void CanariHandleChannelMessage(',
    ]) {
      const start = push.indexOf(fn);
      expect(start, fn).toBeGreaterThan(0);
      const body = push.slice(start, push.indexOf('\n}\n', start));
      expect(body, fn).toContain('CanariAppGroupPath()');
      expect(body, fn).not.toContain('CanariTauriDataDir()');
    }
  });
});

/**
 * `push_context.json` FOLLOWS EVERY EDIT, NOT A LIFECYCLE EVENT (the rule `mls.bin` met in #3040): a
 * process killed in the foreground after an account switch never resigns, so a copy made only by the
 * activation mirror paired account B's state with A's context. Every edit goes through
 * `write_push_context_file`, which copies it into the App Group; the activation mirror hands the file
 * to Rust, under the lock every edit takes, and never copies it itself.
 */
describe('the iOS copy of push_context.json', () => {
  const pushRs = read(resolve(TAURI, 'src/commands/push.rs'));
  const registration = read(resolve(TAURI, 'src/commands/push_registration.rs'));
  /** The text of `fn name(` up to the first line holding only `}`. */
  const fnBody = (src: string, name: string) => {
    const start = src.indexOf(`fn ${name}(`);
    expect(start, name).toBeGreaterThan(0);
    return src.slice(start, src.indexOf('\n}\n', start));
  };

  it('is written by one writer that every edit goes through', () => {
    for (const [name, src] of [
      ['push.rs', pushRs],
      ['push_registration.rs', registration],
    ] as const) {
      // The app's own directory is `data_dir` in shipped code; the tests' scratch directories are
      // named otherwise, and write fixtures there.
      const direct = [...src.matchAll(/std::fs::write\(([^,]+),/g)]
        .map((m) => m[1].trim())
        .filter((target) => /^&?data_dir/.test(target))
        .filter((target) => /push_context|PUSH_CONTEXT_FILE/.test(target));
      // Only the one writer names the file.
      expect(direct, name).toEqual(name === 'push.rs' ? ['data_dir.join(PUSH_CONTEXT_FILE)'] : []);
    }
    // The edits that read the file into a `path` and patch it hand the result to the writer.
    for (const name of ['store_device_identity', 'set_push_context_locale']) {
      expect(fnBody(pushRs, name)).toContain('write_push_context_file(&data_dir, ');
      expect(fnBody(pushRs, name)).not.toContain('std::fs::write(');
    }
    const strip = fnBody(registration, 'keep_device_context_only');
    expect(strip).toContain('crate::commands::push::write_push_context_file_then(');
    // The extension's copy follows the strip inside the same hold of the lock (review of #3075).
    expect(strip).toContain('crate::commands::push::sync_push_context_copy(dir, group)');
    expect(strip).not.toContain('std::fs::write(');
    // ...and nothing after the lock touches that copy: a sign-in landing there keeps its own.
    expect(fnBody(registration, 'end_push_registration_files_then')).not.toContain(
      'PUSH_CONTEXT_FILE'
    );
    expect(fnBody(pushRs, 'write_push_context_file')).toContain(
      'write_push_context_file_then(data_dir, json, follow_push_context_in_extension)'
    );
  });

  it('is mirrored at activation through Rust, under the lock', () => {
    const start = push.indexOf('void CanariMirrorPushStateToAppGroup(void) {');
    const body = push.slice(start, push.indexOf('\n}\n', start));
    expect(body).toContain('canari_ios_mirror_push_context_to_app_group(src.UTF8String)');
    expect(body).not.toMatch(/@\[[^\]]*kPushContextFileName/);
    expect(header).toContain(
      'int canari_ios_mirror_push_context_to_app_group(const char *data_dir);'
    );
    expect(pushRs).toContain(
      'pub unsafe extern "C" fn canari_ios_mirror_push_context_to_app_group('
    );
    expect(fnBody(pushRs, 'mirror_push_context_copy')).toContain(
      'let _guard = push_context_guard();'
    );
  });
});

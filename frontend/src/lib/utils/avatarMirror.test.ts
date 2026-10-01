import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The foreground -> notification avatar mirror: the WebView's call, the Rust command it reaches,
 * and the Kotlin reader whose FILE NAME both must agree on. Three toolchains, one file name - so the
 * name is pinned here, where all three sources can be read at once.
 */
const invoke = vi.fn();
let android = true;
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('$lib/utils/appVersion', () => ({ isAndroidTauriRuntime: () => android }));

const { mirrorAvatarToNative } = await import('./avatarMirror');

const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../src-tauri');
const rust = readFileSync(join(TAURI, 'src/commands/notifications.rs'), 'utf8');
const libRs = readFileSync(join(TAURI, 'src/lib.rs'), 'utf8');
const kotlin = readFileSync(
  join(TAURI, 'gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
  'utf8'
);
const avatarSvelte = readFileSync(join(here, '../components/shared/Avatar.svelte'), 'utf8');

beforeEach(() => {
  invoke.mockReset();
  android = true;
});

describe('mirrorAvatarToNative', () => {
  it('sends the bytes as a plain array, in the arguments the command declares', async () => {
    // NOT a raw invoke body: Android's IPC hands a typed array over as JSON, and the raw-body
    // version was refused on the Mi 9T ("the body is not raw bytes").
    invoke.mockResolvedValue(undefined);
    await mirrorAvatarToNative('user-1', new Blob([new Uint8Array([0xff, 0xd8, 0xff])]));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('store_avatar_mirror', {
      userId: 'user-1',
      data: [0xff, 0xd8, 0xff],
    });
    expect(rust).toMatch(
      /fn store_avatar_mirror\(\s*app: tauri::AppHandle,\s*user_id: String,\s*data: Vec<u8>,/
    );
  });

  it('asks nothing off Android, and nothing for a face with no owner', async () => {
    android = false;
    await mirrorAvatarToNative('user-1', new Blob([new Uint8Array([1])]));
    android = true;
    await mirrorAvatarToNative('  ', new Blob([new Uint8Array([1])]));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('says so when the native side refuses, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValue(new Error('3 bytes that are not an image'));
    await expect(
      mirrorAvatarToNative('user-1', new Blob([new Uint8Array([1, 2, 3])]))
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[AVATAR_MIRROR] store failed'));
  });
});

describe('the three halves agree', () => {
  it('registers the command', () => {
    expect(libRs).toContain('store_avatar_mirror,');
    expect(rust).toContain('pub(crate) fn store_avatar_mirror(');
  });

  it('spells the file name the Kotlin reader reads', () => {
    // Kotlin: every char outside [a-zA-Z0-9_-] becomes `_`, the first 40 are kept, `avatar_` + `.jpg`.
    expect(kotlin).toContain('val safeId = userId.replace(Regex("[^a-zA-Z0-9_-]"), "_").take(40)');
    expect(kotlin).toContain('File(filesDir, "avatar_$safeId.jpg")');
    expect(rust).toContain("if c.is_ascii_alphanumeric() || c == '_' || c == '-' {");
    expect(rust).toContain('.take(40)');
    expect(rust).toContain('format!("avatar_{safe}")');
    expect(rust).toContain('format!("{stem}.jpg")');
    // ...and the marker the reader writes, which the mirror must delete.
    expect(kotlin).toContain('"${cacheFile.nameWithoutExtension}.absent"');
    expect(rust).toContain('format!("{stem}.absent")');
  });

  it('is handed the user id by the component that knows it', () => {
    expect(avatarSvelte).toContain('resolveUserAvatarDisplayUrl(httpUrl, userId)');
  });
});

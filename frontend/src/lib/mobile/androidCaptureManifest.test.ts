import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE SYSTEM CAMERA IS NOT REACHABLE FROM THIS APP, AND THE MANIFEST MUST NOT SAY OTHERWISE.
 *
 * User decision D-camera, 2026-10-11: *"je ne veux pas d'acces a la camera native"* - the in-app
 * CanaReel camera is the only capture path. The manifest used to `<queries>` for
 * `ACTION_IMAGE_CAPTURE` / `ACTION_VIDEO_CAPTURE` (so wry's file chooser could launch them) and the
 * FileProvider exposed `Pictures/` for the photo that chooser wrote. Both are gone with the capture
 * inputs; this pins their absence, because `tauri android init` can regenerate the manifest and a
 * returning query silently re-opens a path nobody offers any more.
 *
 * Comments are stripped first: the manifest's own comment names both actions, and a commented tag is
 * not a tag.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(here, '../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml');

/**
 * The XML with every comment cut out. Split on the markers rather than a regex replace, which a
 * sanitiser scanner reads as an incomplete HTML sanitisation - this is a test reading a file we
 * own, and a split has no residue for it to accuse.
 */
function withoutComments(xml: string): string {
  return xml
    .split('<!--')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('-->') + 3)))
    .join('');
}

const manifest = withoutComments(readFileSync(MANIFEST, 'utf8'));

describe('AndroidManifest has no system camera path', () => {
  it('queries for neither capture intent', () => {
    expect(manifest).not.toMatch(/android\.media\.action\.IMAGE_CAPTURE/);
    expect(manifest).not.toMatch(/android\.media\.action\.VIDEO_CAPTURE/);
  });

  it('exposes no capture output directory to the FileProvider', () => {
    const paths = withoutComments(
      readFileSync(resolve(MANIFEST, '../res/xml/file_paths.xml'), 'utf8')
    );
    expect(paths).not.toMatch(/path="Pictures\/"/);
  });

  it('keeps the CAMERA permission the in-app camera (getUserMedia) is asked through', () => {
    expect(manifest).toMatch(/<uses-permission android:name="android\.permission\.CAMERA"\s*\/>/);
  });
});

/**
 * NO ANDROID HAPTIC FIRES WITHOUT `VIBRATE`. `navigator.vibrate` (MessageBubble, ReelCapture,
 * useNotifications) reaches Chromium's VibrationManager, which refuses silently to the page with
 * `cr_VibrationManager: Failed to use vibrate API, requires VIBRATE permission` in logcat -
 * measured on the Mi 9T, build 5b56dcb74. The call returns without error, so nothing here sees it.
 */
describe('AndroidManifest haptics', () => {
  it('declares the VIBRATE permission', () => {
    expect(manifest).toMatch(/<uses-permission android:name="android\.permission\.VIBRATE"\s*\/>/);
  });
});

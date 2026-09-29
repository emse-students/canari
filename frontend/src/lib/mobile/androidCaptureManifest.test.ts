import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE CAMERA APP MUST BE VISIBLE, OR "APPAREIL PHOTO" OPENS THE PHOTO PICKER.
 *
 * The composer's camera chips are file inputs carrying `capture`. On Android they reach wry's
 * `RustWebChromeClient.onShowFileChooser`, which launches `ACTION_IMAGE_CAPTURE` /
 * `ACTION_VIDEO_CAPTURE` only when `resolveActivity()` finds a handler - and since API 30 that
 * returns null for every app the manifest does not QUERY for. wry then falls back to the picker,
 * so the chip still "works" and shows the wrong screen: measured on the Mi 9T on 2026-09-29, with
 * `Tauri/FileChooser: Media capture intent could not be launched` in logcat.
 *
 * Nothing at compile time sees it, and `tauri android init` can regenerate the manifest - hence a
 * test. Comments are stripped first: the manifest's own comment names both actions, and a
 * commented tag satisfying a `toContain` is how a removal becomes a false green.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(here, '../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml');

const manifest = readFileSync(MANIFEST, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const queries = manifest.match(/<queries>[\s\S]*?<\/queries>/)?.[0] ?? '';

describe('AndroidManifest camera capture visibility', () => {
  it('queries for the still-image capture intent', () => {
    expect(queries).toMatch(/android:name="android\.media\.action\.IMAGE_CAPTURE"/);
  });

  it('queries for the video capture intent', () => {
    expect(queries).toMatch(/android:name="android\.media\.action\.VIDEO_CAPTURE"/);
  });

  /*
   * THE SECOND HALF OF THE SAME FAILURE, found once the first was fixed. For a photo wry creates
   * the output file in getExternalFilesDir(DIRECTORY_PICTURES) and asks the FileProvider for a URI
   * to it; a provider with no root covering that directory throws, and wry falls back to the picker
   * exactly as before. Same symptom, second cause - hence both are pinned.
   */
  it('exposes the app-specific Pictures directory to the FileProvider', () => {
    const paths = readFileSync(resolve(MANIFEST, '../res/xml/file_paths.xml'), 'utf8').replace(
      /<!--[\s\S]*?-->/g,
      ''
    );
    expect(paths).toMatch(/<external-files-path\b[^>]*path="Pictures\/"/);
  });
});

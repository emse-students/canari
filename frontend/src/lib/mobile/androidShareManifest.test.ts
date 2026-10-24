import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CANARI IS A SHARE TARGET ON ANDROID, AND ONLY THE HAND-MAINTAINED MANIFEST SAYS SO.
 *
 * `tauri android init` regenerates the manifest from a template that has no SEND filter, and the
 * app keeps building without it: Canari just silently disappears from every "Partager" sheet. This
 * pins the filter on the activity that handles it (`MainActivity` -> `IncomingShare`), with the
 * kinds of content the page knows how to offer.
 *
 * Comments are stripped first: a commented tag is not a tag.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(here, '../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml');

function withoutComments(xml: string): string {
  return xml
    .split('<!--')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('-->') + 3)))
    .join('');
}

const manifest = withoutComments(readFileSync(MANIFEST, 'utf8'));

/** The `<activity>` element declaring MainActivity, up to its closing tag. */
function mainActivity(): string {
  const start = manifest.indexOf('android:name=".MainActivity"');
  expect(start).toBeGreaterThan(-1);
  const open = manifest.lastIndexOf('<activity', start);
  const close = manifest.indexOf('</activity>', start);
  return manifest.slice(open, close);
}

/** The intent-filter of MainActivity that carries the SEND action. */
function shareFilter(): string {
  const activity = mainActivity();
  const filters = activity.split('<intent-filter').slice(1);
  const share = filters.find((f) => f.includes('android.intent.action.SEND"'));
  expect(share, 'MainActivity has no SEND intent-filter').toBeDefined();
  return share ?? '';
}

describe('AndroidManifest makes Canari a share target', () => {
  it('takes SEND and SEND_MULTIPLE on MainActivity, in the DEFAULT category', () => {
    const filter = shareFilter();
    expect(filter).toMatch(/android\.intent\.action\.SEND_MULTIPLE/);
    expect(filter).toMatch(/android\.intent\.category\.DEFAULT/);
  });

  it.each(['text/*', 'image/*', 'video/*', 'audio/*', 'application/*'])('accepts %s', (mime) => {
    expect(shareFilter()).toContain(`android:mimeType="${mime}"`);
  });

  it('keeps MainActivity single-task, so a share reaches the running page through onNewIntent', () => {
    expect(mainActivity()).toMatch(/android:launchMode="singleTask"/);
  });
});

/**
 * The copies are made in ONE directory and read through ONE allowlist, written in two languages.
 * On Android `take_picked_file`'s other roots are the EXTERNAL cache and the process temp
 * directory, not the app cache the copies land in: if the two names drift apart, every shared file
 * is refused by the page with no build failing - which is how this was first written (2026-10-21).
 */
describe('the shared inbox is the directory take_picked_file allows', () => {
  const kotlin = readFileSync(
    resolve(
      here,
      '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/IncomingShare.kt'
    ),
    'utf8'
  );
  const rust = readFileSync(
    resolve(here, '../../../src-tauri/src/commands/picked_files.rs'),
    'utf8'
  );

  it('names the same directory on both sides, under the app cache', () => {
    const copiedInto = /INBOX_DIR = "([^"]+)"/.exec(kotlin)?.[1];
    const allowed = /const SHARED_INBOX: &str = "([^"]+)";/.exec(rust)?.[1];
    expect(copiedInto).toBeDefined();
    expect(allowed).toBe(copiedInto);
    expect(kotlin).toMatch(/File\(context\.cacheDir, INBOX_DIR\)/);
    expect(rust).toMatch(/app_cache_dir\(\)\.ok\(\)\?\.join\(SHARED_INBOX\)/);
  });

  it('reads the share epoch from the file the sign-out advances', () => {
    const handoff = readFileSync(
      resolve(here, '../../../src-tauri/src/commands/handoff.rs'),
      'utf8'
    );
    const read = /EPOCH_FILE = "([^"]+)"/.exec(kotlin)?.[1];
    const advanced = /const SHARE_EPOCH_FILE: &str = "([^"]+)";/.exec(handoff)?.[1];
    expect(read).toBeDefined();
    expect(advanced).toBe(read);
    expect(kotlin).toMatch(/File\(MlsContextLoader\.tauriDataDir\(context\), EPOCH_FILE\)/);
  });
});

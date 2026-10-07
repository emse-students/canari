import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Android message notification: who is named above each line, and which avatar answers are
 * remembered.
 *
 * Both are Kotlin in `CanariFirebaseMessagingService.kt`, which no JVM test here compiles - so, as
 * `initialsFallback.test.ts` does, the decisions are pinned in the source. What they look like on a
 * phone is read on the Mi 9T and recorded in `docs/wiki/frontend/mobile.md`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = resolve(here, '../../../src-tauri/gen/android/app/src/main');
const kotlin = readFileSync(
  join(ANDROID, 'java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
  'utf8'
);
const stringsFr = readFileSync(join(ANDROID, 'res/values/strings.xml'), 'utf8');
const stringsEn = readFileSync(join(ANDROID, 'res/values-en/strings.xml'), 'utf8');

/** The body of one Kotlin function, from its signature to the next declaration at its depth. */
function body(signature: string): string {
  const start = kotlin.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = kotlin.indexOf('\n        private fun ', start + signature.length);
  return kotlin.slice(start, next === -1 ? undefined : next);
}

describe('a message notification names every author (user, 2026-10-01)', () => {
  it('labels our own lines "Vous" / "You", a name beside a name', () => {
    expect(stringsFr).toContain('<string name="notif_sender_self">Vous</string>');
    expect(stringsEn).toContain('<string name="notif_sender_self">You</string>');
  });

  it('gives a direct message the group shape, with no title', () => {
    // From API 28 the platform decides one-to-one from isGroupConversation ALONE, and a one-to-one
    // thread hides the other person's name above their lines - the asymmetry the user reported.
    // Titled with the person, the Mi 9T printed the name twice; untitled, once.
    expect(kotlin).toContain('val conversationTitle = if (isGroup) groupName else null');
    expect(kotlin).toContain('if (isGroup || namesEachSender) style.isGroupConversation = true');
  });

  it('is asked for by the two MESSAGE triggers and by nothing else', () => {
    // The push and the WebSocket frame. A reaction (a sentence about the actor) and a salon (whose
    // "sender" IS its title) keep the old shape, or the title would be printed twice.
    expect(kotlin.match(/namesEachSender = true/g)).toHaveLength(2);
    expect(kotlin).toContain('namesEachSender: Boolean = false');
  });
});

describe('the avatar cache remembers "no picture", and only that', () => {
  const icon = body('private fun Context.cachedRemoteIcon(');

  it('writes the marker on a 404 and on nothing else', () => {
    expect(icon).toContain('} else if (code == 404) {');
    expect(icon.match(/absent\.writeBytes\(/g)).toHaveLength(1);
    const writeAt = icon.indexOf('absent.writeBytes(');
    expect(writeAt).toBeGreaterThan(icon.indexOf('} else if (code == 404) {'));
    expect(writeAt).toBeLessThan(icon.indexOf('} else {', icon.indexOf('code == 404')));
  });

  it('never remembers a 502, a 503 or a transport failure', () => {
    const otherwise = icon.slice(icon.indexOf('} else {', icon.indexOf('code == 404')));
    expect(otherwise).not.toContain('writeBytes');
    expect(otherwise).toContain('not remembered');
  });

  it('asks the image first and the marker second, on one clock, before any request', () => {
    const image = icon.indexOf('cacheFile.lastModified()) < AVATAR_CACHE_MAX_AGE_MS');
    const marker = icon.indexOf('absent.lastModified()) < AVATAR_CACHE_MAX_AGE_MS');
    const request = icon.indexOf('request() ?: return null');
    expect(image).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(image);
    expect(request).toBeGreaterThan(marker);
  });

  it('drops the marker when a picture arrives, and the picture when the answer is "none"', () => {
    expect(icon).toContain('absent.exists() && !absent.delete()');
    expect(icon).toContain('cacheFile.exists() && !cacheFile.delete()');
  });

  it('keeps the marker under the avatar_ prefix the device wipe erases', () => {
    // storage.rs empties `files/` by the prefix `avatar_`; a marker named otherwise would survive
    // a revocation and say, of a real person, that they have no photo.
    expect(kotlin).toContain('"${cacheFile.nameWithoutExtension}.absent"');
    expect(kotlin).toContain('File(filesDir, "avatar_$safeId.jpg")');
  });
});

describe('a conversation notification shows one identity (user, 2026-10-05)', () => {
  it('hands a group-shaped post to the platform as a conversation, through a shortcut', () => {
    expect(kotlin).toContain('if (!isReactionNotif && (isGroup || namesEachSender))');
    expect(kotlin).toContain('ShortcutManagerCompat.pushDynamicShortcut(context, info)');
    expect(kotlin).toContain('.setLongLived(true)');
    expect(kotlin).toContain('setShortcutId(conversationShortcutId)');
  });

  it('keeps the plain large icon only where the shortcut-less shape is kept', () => {
    expect(kotlin).toContain('else setLargeIcon(largeIcon)');
  });
});

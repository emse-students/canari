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

  it('takes the title and the group flag from ConversationShape, after the shortcut is known', () => {
    // On API 30+ SystemUI titles a shortcut-backed post with the shortcut's label, so a DM in the
    // group shape read its sender twice (owner, 2026-11-11). The decision itself is pinned by the
    // JVM test `ConversationShapeTest`; this pins that the builder applies it, and only once the
    // shortcut has been published.
    const shortcutAt = kotlin.indexOf('val conversationShortcutId = ');
    const shapeAt = kotlin.indexOf('val shape = ConversationShape.of(');
    expect(shortcutAt).toBeGreaterThan(-1);
    expect(shapeAt).toBeGreaterThan(shortcutAt);
    expect(kotlin).toContain('hasShortcut = conversationShortcutId != null');
    expect(kotlin).toContain('style.isGroupConversation = shape.groupConversation');
    expect(kotlin).not.toContain(
      'if (isGroup || namesEachSender) style.isGroupConversation = true'
    );
  });

  it("decides group or DM from the source's isGroup, the name only when it did not say", () => {
    // A third of production groups carry no name (push-payload.ts); the name rule read them as a DM
    // with their first speaker (review of #3344, M1). The push passes the payload's field, the
    // socket trigger the WebView's conversation type, a salon `true`; an unnamed group is titled
    // "Conversation de groupe", never with its first speaker.
    expect(kotlin).toContain(
      'val isGroup = ConversationShape.isGroup(groupName, senderName, declaredGroup)'
    );
    expect(kotlin.match(/declaredGroup = isGroup,/g)).toHaveLength(2);
    expect(kotlin).toContain('declaredGroup = true,');
    expect(kotlin).toContain('isGroup: Boolean?,');
    expect(kotlin).toContain('res.getString(R.string.notif_unnamed_group)');
    expect(stringsFr).toContain(
      '<string name="notif_unnamed_group">Conversation de groupe</string>'
    );
    expect(stringsEn).toContain('<string name="notif_unnamed_group">Group conversation</string>');
  });

  it('keeps the conversation shortcut on the re-post of a failed reply', () => {
    expect(kotlin).toContain('existing.shortcutId?.let { setShortcutId(it) }');
  });

  it('is asked for by the two MESSAGE triggers and the salon push, and by nothing else', () => {
    // The MLS push, the WebSocket frame (DMs, groups and salons), and since 2026-11-01 the salon
    // push, whose line names its speaker under the salon's title (`ChannelBannerAuthor`). A reaction
    // (a sentence about the actor) keeps the old shape, or the actor would be printed twice.
    expect(kotlin.match(/namesEachSender = true/g)).toHaveLength(3);
    expect(kotlin).toContain('namesEachSender: Boolean = false');
  });
});

describe('an unreadable direct message does not repeat its sender (owner, 2026-11-11)', () => {
  const APPLE = resolve(here, '../../../src-tauri/gen/apple');
  const read = (path: string) => readFileSync(join(APPLE, path), 'utf8');

  it('Android picks the line through FallbackLine, given the group name', () => {
    // The decision itself is pinned by the JVM test `FallbackLineTest`.
    expect(kotlin).toContain(
      // `shownName`: the sender's nickname in that conversation, else the profile (2026-11-14).
      'buildFallbackText(appLocaleContext(this), shownName, groupName, isGroup)'
    );
    expect(kotlin).toContain(
      'FallbackLine.Kind.NEW_MESSAGE -> res.getString(R.string.notif_new_message)'
    );
    expect(stringsFr).toContain('<string name="notif_new_message">Nouveau message</string>');
    expect(stringsEn).toContain('<string name="notif_new_message">New message</string>');
  });

  it('iOS reads the same rule in the extension and in the app', () => {
    const nse = read('canari_NSE/NotificationService.swift');
    const app = read('Sources/canari/canari_push.mm');
    // The extension's two fallbacks: no push context (the push's name), and the decrypt's (the
    // sender's nickname in that conversation when the phone holds one, owner 2026-11-14).
    expect(nse).toContain(
      'senderName: senderName, groupName: groupName, declared: isGroup, locale: nil'
    );
    expect(nse).toContain(
      'senderName: shownName, groupName: groupName, declared: isGroup, locale: ctx.locale'
    );
    expect(nse.match(/groupName: groupName, declaredGroup: isGroup,/g)).toHaveLength(2);
    expect(nse).toContain('declared ?? (!groupName.isEmpty && groupName != senderName)');
    expect(nse).toContain('return localized("notif.message.new", locale: locale)');
    expect(app).toContain('CanariBuildFallbackText(shownName, groupName, isGroup)');
    expect(app).toContain('shownName, NO, YES, nil, isGroup);');
    expect(app).toContain('if (declared != nil) return declared.boolValue;');
    expect(app).toContain('return CanariLocalized(@"notif.message.new");');
    for (const bundle of ['canari_NSE', 'canari_iOS']) {
      expect(read(`${bundle}/fr.lproj/Localizable.strings`)).toContain(
        '"notif.message.new" = "Nouveau message";'
      );
      expect(read(`${bundle}/en.lproj/Localizable.strings`)).toContain(
        '"notif.message.new" = "New message";'
      );
      expect(read(`${bundle}/fr.lproj/Localizable.strings`)).toContain(
        '"notif.group.unnamed" = "Conversation de groupe";'
      );
      expect(read(`${bundle}/en.lproj/Localizable.strings`)).toContain(
        '"notif.group.unnamed" = "Group conversation";'
      );
    }
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
    // Never for a salon (2026-11-01): the shortcut cap is shared with the DMs and the share sheet.
    expect(kotlin).toContain(
      'if (!isReactionNotif && !groupId.startsWith("channel_") && (isGroup || namesEachSender))'
    );
    // Through the recorder, so the sign-out can erase it (sharing lot S5).
    expect(kotlin).toContain('ConversationShortcuts.push(context, info)');
    expect(kotlin).toContain('.setLongLived(true)');
    expect(kotlin).toContain('setShortcutId(conversationShortcutId)');
  });

  it('keeps the plain large icon only where the shortcut-less shape is kept', () => {
    expect(kotlin).toMatch(/\} else \{\s*setLargeIcon\(largeIcon\)\s*\}/);
  });

  it('never lends a face from a line it did not add (review of #2881, HIGH-1)', () => {
    // The second trigger of one message adds no line; its own icon then describes nothing shown,
    // so the large icon is the face of the line the shade shows last.
    expect(kotlin).toMatch(
      /\} else if \(alreadyPosted\) \{[\s\S]{0,500}val shownFace = style\.messages\s*\.lastOrNull \{ it\.person != null && it\.person\?\.name != selfPerson\.name \}\s*\?\.person\?\.icon\?\.toIcon\(/
    );
    // The reader's own inline reply is attributed to the style's user (`selfPerson`, or no Person):
    // its face is never the conversation's (review of #2888, LOW-2).
    expect(kotlin).toContain('previous.user');
  });

  it('retires the salon shortcuts once, and never on an unreadable record (review of #2888, LOW-3)', () => {
    // An unreadable record is not "nothing recorded": the removal answers null, and the done flag
    // is written only for a non-null answer, so the next start tries again.
    const shortcuts = readFileSync(
      resolve(
        here,
        '../../../src-tauri/plugins/tauri-plugin-gallery/android/src/main/java/ConversationShortcuts.kt'
      ),
      'utf8'
    );
    const record = readFileSync(
      resolve(
        here,
        '../../../src-tauri/plugins/tauri-plugin-gallery/android/src/main/java/ShortcutRecord.kt'
      ),
      'utf8'
    );
    const application = readFileSync(
      resolve(
        here,
        '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariApplication.kt'
      ),
      'utf8'
    );
    expect(shortcuts).toContain('val ids = record.readOrNull(context) ?: return null');
    expect(record).toMatch(/is unreadable: \$\{e\.message\}"\)\s*null\s*\}/);
    expect(application).toMatch(
      /if \(removed != null\) \{\s*migrations\.edit\(\)\.putBoolean\(SALON_SHORTCUTS_RETIRED, true\)\.apply\(\)/
    );
  });
});

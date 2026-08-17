import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The initials disc, held across the three notification implementations.
 *
 * When a notification's avatar cannot be fetched - the request failed, or the person simply has no
 * photo - Android has always drawn a coloured disc with the first letter of a name, and both iOS
 * paths drew NOTHING. The same event therefore looked like two different products depending on the
 * phone, and on iOS it looked like a defect.
 *
 * There are now three implementations and there cannot be fewer: Kotlin for Android, Objective-C
 * for the iOS app, and Swift for the notification extension, which is a separate bundle that shares
 * no code with the app. **Three copies of one appearance is exactly the shape that drifts**, and
 * nothing else in the repository can compare them - each is compiled by a different toolchain, and
 * two of the three are compiled by CI alone.
 *
 * So this file asserts the two things that must be IDENTICAL (the colour, the letter ratio), the
 * one that must legitimately DIFFER and why, and the choice each platform makes about whose letter
 * is drawn - which is the subtle half, since a salon draws the salon and not the person who spoke.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../src-tauri/gen');

const kotlin = readFileSync(
  join(TAURI, 'android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
  'utf8'
);
const objc = readFileSync(join(TAURI, 'apple/Sources/canari/canari_push.mm'), 'utf8');
const swift = readFileSync(join(TAURI, 'apple/canari_NSE/NotificationService.swift'), 'utf8');

describe('the initials disc, across the three notification implementations', () => {
  it('exists on all three', () => {
    // A vacuous pass otherwise: every assertion below is a substring match, and a file read from
    // the wrong path is an empty string that fails nothing.
    expect(kotlin).toContain('private fun generateInitialsBitmap(');
    expect(objc).toContain('static NSString *_Nullable CanariInitialsImagePath(');
    expect(swift).toContain('private static func initialsImageUrl(');
  });

  it('draws the same colour everywhere', () => {
    // Kotlin writes it as a CSS hex, the two Apple languages as three channel bytes, because
    // UIColor takes components. Same colour, three spellings - so it is compared per channel.
    expect(kotlin).toContain('#6366f1');
    for (const source of [objc, swift]) {
      expect(source).toContain('0x63');
      expect(source).toContain('0x66');
      expect(source).toContain('0xf1');
    }
  });

  it('uses the same letter ratio everywhere', () => {
    expect(kotlin).toContain('size * 0.4f');
    expect(objc).toContain('kCanariInitialsLetterRatio = 0.4');
    expect(swift).toContain('kInitialsLetterRatio: CGFloat = 0.4');
  });

  it('renders iOS larger than Android, deliberately', () => {
    // NOT a drift: an Android large icon is a small square beside the text, an iOS attachment is
    // rendered at banner size. The two Apple copies must still agree with each other.
    expect(kotlin).toContain('val size   = 96');
    expect(objc).toContain('kCanariInitialsSize = 192');
    expect(swift).toContain('kInitialsSize: CGFloat = 192');
  });

  it('falls back on every path that can show a face', () => {
    // Three paths per platform: a message, a reaction, a salon message. A fourth path added
    // without a fallback is the regression this counts - iOS showed nothing on all three.
    expect(kotlin.match(/generateInitialsBitmap\(/g)).toHaveLength(4); // 3 calls + the definition
    expect(swift.match(/attachInitials\(/g)).toHaveLength(4); // 3 calls + the definition
    // The ObjC trunk serves the message AND the salon paths, so it has two call sites, not three.
    expect(objc.match(/CanariInitialsImagePath\(/g)).toHaveLength(3); // 2 calls + the definition
  });

  it('draws the SALON, not the speaker, on a channel notification', () => {
    // The subtle one. A salon notification is titled `<Communaute> - #<salon>`, so a fallback that
    // took the title's first character would draw the community - or a bare `#` when the community
    // could not be named. Both platforms pass the salon explicitly instead.
    expect(kotlin).toContain('generateInitialsBitmap(channelName)');
    expect(swift).toContain('attachInitials(content: content, name: channelName)');
    expect(objc).toContain('mentionsMe, channelName);');
  });

  it('writes to a temp file, never to the avatar cache', () => {
    // The OS CONSUMES the file an attachment names. Writing the disc anywhere durable would mean
    // handing the system a path something else still needs.
    expect(objc).toContain('NSTemporaryDirectory()');
    expect(swift).toContain('NSTemporaryDirectory()');
  });
});

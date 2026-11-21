import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE iPHONE'S MESSAGE BANNERS ARE COMMUNICATION NOTIFICATIONS (owner, 2026-11-21), AND NOTHING ON
 * THIS MACHINE COMPILES ANY OF IT.
 *
 * The notification extension (`canari_NSE/NotificationService.swift`) donates an incoming
 * `INSendMessageIntent` and redraws the banner from it; the app carries the entitlement and the
 * activity type; the gallery plugin (`ShareSuggestions.swift`, another bundle) deletes the
 * extension's donation group at sign-out. Every agreement between them is a string spelled twice,
 * and a drift is silent: a Focus that never lets a sender through, or a sender's name and face left
 * with the system after the account signed out. This reads the sources and fails on the drift.
 * See `docs/wiki/frontend/mobile.md` "Communication notifications".
 */
const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../src-tauri');
const APPLE = resolve(TAURI, 'gen/apple');
const GALLERY = resolve(TAURI, 'plugins/tauri-plugin-gallery');

const read = (path: string) => readFileSync(path, 'utf8');

const nse = read(resolve(APPLE, 'canari_NSE/NotificationService.swift'));
const appEntitlements = read(resolve(APPLE, 'canari_iOS/canari_iOS.entitlements'));
const appInfo = read(resolve(APPLE, 'canari_iOS/Info.plist'));
const suggestions = read(resolve(GALLERY, 'ios/Sources/ShareSuggestions.swift'));
const plugin = read(resolve(GALLERY, 'ios/Sources/GalleryPlugin.swift'));
const commands = read(resolve(GALLERY, 'src/commands.rs'));

/** The first capture of `re` in `source`, failing the test when there is none. */
function capture(source: string, re: RegExp): string {
  const match = re.exec(source);
  expect(match, `${re} matched nothing`).not.toBeNull();
  return match![1];
}

/** `xml` with every `<!-- ... -->` comment cut out, so a commented-out key never passes. */
function withoutXmlComments(xml: string): string {
  return xml
    .split('<!--')
    .map((part, i) => {
      if (i === 0) return part;
      const end = part.indexOf('-->');
      return end < 0 ? '' : part.slice(end + '-->'.length);
    })
    .join('');
}

/** The body of `applyCommunicationStyle` up to the next declaration. */
const styleStep = capture(
  nse,
  /private func applyCommunicationStyle\(([\s\S]*?)\n {2}\/\/\/ Replaces the best-attempt/
);
const adopt = capture(nse, /private func adoptCommunicationContent\(([\s\S]*?)\n {2}\}\n/);

describe('the app declares what a communication notification needs', () => {
  it('carries the communication entitlement, on the APP target (Apple asks it there)', () => {
    expect(withoutXmlComments(appEntitlements)).toMatch(
      /<key>com\.apple\.developer\.usernotifications\.communication<\/key>\s*<true\/>/
    );
  });

  it('declares INSendMessageIntent in NSUserActivityTypes', () => {
    expect(withoutXmlComments(appInfo)).toMatch(
      /<key>NSUserActivityTypes<\/key>\s*<array>[\s\S]*?<string>INSendMessageIntent<\/string>[\s\S]*?<\/array>/
    );
  });
});

describe('the extension donates, THEN redraws', () => {
  it('donates an INCOMING interaction in its own group', () => {
    expect(nse).toContain('import Intents');
    expect(styleStep).toContain('interaction.direction = .incoming');
    expect(styleStep).toContain('interaction.groupIdentifier = Self.messageNotificationsGroup');
  });

  it('redraws only from the donation completion - no clock, no wait', () => {
    const donate = styleStep.indexOf('interaction.donate {');
    expect(donate).toBeGreaterThan(-1);
    expect(styleStep.indexOf('self.adoptCommunicationContent(', donate)).toBeGreaterThan(donate);
    expect(styleStep).not.toMatch(/DispatchSemaphore|asyncAfter|\.wait\(/);
    // The plain notification is complete BEFORE the step: the expiry delivers it if no completion comes.
    expect(nse).toMatch(
      /applyBadgeCount\(content: content, incomingThreadId: content\.threadIdentifier\)\n[\s\S]{0,300}applyCommunicationStyle\(/
    );
  });

  it('every way out of the step delivers, and the degraded path says WARN with the error type', () => {
    // A skip and the completion both end in `finish`.
    expect(styleStep.match(/finish\(\)/g)?.length).toBe(2);
    expect(styleStep).toMatch(/WARN communication style not applied[^\n]*degraded path/);
    expect(adopt).toMatch(
      /catch \{[\s\S]*?type\(of: error\)[\s\S]*?WARN communication style not applied/
    );
  });

  it('adopts the redraw under the delivery lock, and never after the run was answered', () => {
    expect(adopt).toContain('deliveryLock.lock()');
    expect(adopt).toContain('guard contentHandler != nil');
    expect(adopt).toContain('.updating(from: intent)');
  });

  it('never donates the message: the intent carries no content', () => {
    const intent = capture(nse, /static func messageIntent\(([\s\S]*?)\n {2}\}\n/);
    expect(intent).toMatch(/INSendMessageIntent\([\s\S]*?content: nil,/);
    expect(intent).toContain('conversationIdentifier: conversationId');
  });

  it('adds no network fetch for the face: a thumbnail run reads the avatar from the cache only', () => {
    expect(nse).toContain(
      'face = attached ? cachedAvatar(userId: senderId) : fetchAvatar(ctx: ctx, userId: senderId)'
    );
    expect(capture(nse, /private func cachedAvatar\(([\s\S]*?)\n {2}\}\n/)).toContain('{ nil }');
  });

  it('is applied to MLS messages only - salons, posts and social notifications stay as they were', () => {
    expect(nse.match(/applyCommunicationStyle\(/g)?.length).toBe(2); // the call and the declaration
    const messageContent = capture(
      nse,
      /private func applyMessageContent\(([\s\S]*?)\n {2}\/\/ MARK: - Communication notification/
    );
    expect(messageContent).toContain('applyCommunicationStyle(');
  });
});

describe('the sign-out erases what the extension donated', () => {
  it('spells the donation group and the conversation id prefix the same in both bundles', () => {
    const group = capture(nse, /static let messageNotificationsGroup = "([^"]+)"/);
    expect(group).toBe('fr.emse.canari.message-notifications');
    expect(capture(suggestions, /static let messageNotificationsGroup = "([^"]+)"/)).toBe(group);
    expect(group).not.toBe(capture(suggestions, /static let groupIdentifier = "([^"]+)"/));
    expect(capture(nse, /static let conversationIdPrefix = "([^"]+)"/)).toBe(
      capture(suggestions, /static let idPrefix = "([^"]+)"/)
    );
  });

  it('deletes that group behind clear_conversation_shortcuts, which now serves iOS too', () => {
    expect(suggestions).toContain('deleteGroup(messageNotificationsGroup)');
    expect(plugin).toMatch(
      /func clearConversationShortcuts\([\s\S]*?ShareSuggestions\.clearMessageNotifications/
    );
    const command = capture(
      commands,
      /pub\(crate\) async fn clear_conversation_shortcuts([\s\S]*?)\n\}\n/
    );
    expect(command).toContain('#[cfg(mobile)]');
    expect(command).not.toContain('AndroidOnly');
  });
});

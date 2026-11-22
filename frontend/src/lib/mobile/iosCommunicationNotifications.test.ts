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
    // A skip, a refused donation, a withdrawal's completion and a redraw each end in `finish`.
    expect(styleStep.match(/finish\(\)/g)?.length).toBe(4);
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

describe('no donation outlives the account it named (review of #3938)', () => {
  const skip = capture(nse, /static func communicationSkipReason\(([\s\S]*?)\n {2}\}\n/);

  it('skips the donation FIRST when no whole push context proves an account is signed in', () => {
    expect(skip.indexOf('return "no-account-context"')).toBeGreaterThan(-1);
    expect(skip.indexOf('return "no-account-context"')).toBeLessThan(
      skip.indexOf('return "no-conversation-id"')
    );
    // The proof is the context the sign-out strips of `baseUrl`, never the payload.
    const proof = capture(nse, /static func signedInUserId\(\) -> String\? \{([\s\S]*?)\n {2}\}\n/);
    expect(proof).toContain('!baseUrl.isEmpty');
    expect(nse).toContain('signedInUserId: ctx?.userId)');
  });

  it('a donation the sign-out overtook withdraws exactly itself, blanked, and answers only after', () => {
    expect(styleStep).toContain('interaction.identifier = donationId');
    const withdrawn = capture(
      styleStep,
      /else if Self\.signedInUserId\(\) != donor \{([\s\S]*?)\n {6}\} else \{\s*self\.adoptCommunicationContent/
    );
    // Blanked BEFORE the delete, so an expiry meanwhile delivers the blank one.
    expect(withdrawn.indexOf('self.blankSignedOutContent()')).toBeGreaterThan(-1);
    expect(withdrawn.indexOf('self.blankSignedOutContent()')).toBeLessThan(
      withdrawn.indexOf('INInteraction.delete(with: [donationId])')
    );
    // `finish` runs inside the delete's completion, on both its paths - never beside it.
    const completion = capture(
      withdrawn,
      /INInteraction\.delete\(with: \[donationId\]\) \{ error in([\s\S]*)\}\s*$/
    );
    expect(completion).toMatch(
      /if let error = error \{[\s\S]*?ERROR[\s\S]*?\}[\s\S]*?self\.finish\(\)/
    );
    expect(withdrawn.match(/finish\(\)/g)?.length).toBe(1);
    // The expiry blanks too, when the account the drawn message names signed out since.
    const expiry = capture(
      nse,
      /override func serviceExtensionTimeWillExpire\(\) \{([\s\S]*?)\n {2}\}\n/
    );
    expect(expiry).toMatch(
      /if let named = named, Self\.signedInUserId\(\) != named \{[\s\S]*?blankSignedOutContent\(\)[\s\S]*?let handler = contentHandler/
    );
    expect(nse).toContain('namesContentOf = ctx?.userId');
    const blank = capture(nse, /private func blankSignedOutContent\(\) \{([\s\S]*?)\n {2}\}\n/);
    expect(blank).toContain('deliveryLock.lock()');
    expect(blank).toContain('guard contentHandler != nil');
    for (const field of [
      'title = ""',
      'subtitle = ""',
      'body = ""',
      'sound = nil',
      'attachments = []',
    ]) {
      expect(blank).toContain(`blank.${field}`);
    }
  });

  it('the sign-out strips the context BEFORE it erases the donations', () => {
    const auth = read(resolve(here, '../stores/auth.ts'));
    expect(auth).toContain('const pushEnded = endPushRegistration(options.cause);');
    expect(auth).toContain("void eraseAccountShortcuts('signed out', pushEnded);");
    const native = read(resolve(here, '../sharing/shareTargetsNative.ts'));
    expect(native).toMatch(
      /return Promise\.resolve\(pushEnded\)\.then\(\(ticket\) =>\s*eraseNotificationShortcuts\(reason, 'always', ticket\)/
    );
  });

  it('the erase is OWED on disk from before the strip, and honoured before the next proof exists', () => {
    const rust = read(resolve(TAURI, 'src/commands/push_registration.rs'));
    const files = capture(rust, /fn end_push_registration_files_then\(([\s\S]*?)\n\}\n/);
    expect(files.indexOf('mark_notification_erase_owed(data_dir)')).toBeGreaterThan(-1);
    expect(files.indexOf('mark_notification_erase_owed(data_dir)')).toBeLessThan(
      files.indexOf('keep_device_context_only(data_dir, extension_dir)')
    );
    // Honoured before a session's context is stored, and at launch.
    const mls = read(resolve(here, '../services/TauriMlsService.ts'));
    expect(mls.indexOf('await honourOwedNotificationErase(')).toBeGreaterThan(-1);
    expect(mls.indexOf('await honourOwedNotificationErase(')).toBeLessThan(
      mls.indexOf("invoke('store_push_context'")
    );
    const layout = read(resolve(here, '../../routes/+layout.svelte'));
    expect(layout).toContain("void honourOwedNotificationErase('launch');");
  });

  it('a group mention declares a recipient count, which would otherwise draw it as a DM', () => {
    expect(capture(nse, /static let mentionedGroupRecipientCount = (\d+)/)).toBe('2');
    expect(nse).toContain(
      'metadata.recipientCount = groupName == nil ? 1 : mentionedGroupRecipientCount'
    );
  });

  it('the stand-in for a group is never offered as a contact', () => {
    const intent = capture(nse, /static func messageIntent\(([\s\S]*?)\n {2}\}\n/);
    expect(intent).toContain('suggestionType: .none)');
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

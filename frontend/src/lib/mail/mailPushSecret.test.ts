import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIL_HOST } from './soapClient';
import { INBOX_FOLDER_ID } from './mailWatcher';

/**
 * Mail lot 5's native halves hold the same names: the Keychain item the app writes
 * (`mail_push_secret.rs`) is the one the iOS extension reads (`NotificationService.swift`
 * `MailPushRules`), and the extension reads the mailbox and the cursor the page does. Neither native
 * side compiles here, so the names are held together from their sources.
 */
const root = resolve(__dirname, '../../../src-tauri');
const rust = readFileSync(resolve(root, 'src/commands/mail_push_secret.rs'), 'utf8');
const swift = readFileSync(resolve(root, 'gen/apple/canari_NSE/NotificationService.swift'), 'utf8');
const watch = readFileSync(resolve(root, 'src/commands/mail_watch.rs'), 'utf8');
const objc = readFileSync(resolve(root, 'gen/apple/Sources/canari/canari_push.mm'), 'utf8');

const rustConst = (name: string) => new RegExp(`const ${name}: &str = "([^"]+)"`).exec(rust)?.[1];
const swiftLet = (name: string) => new RegExp(`static let ${name} = "([^"]+)"`).exec(swift)?.[1];

describe('the mail push secret, across Rust, Swift and the page', () => {
  it('names one Keychain item', () => {
    expect(rustConst('KEYCHAIN_SERVICE')).toBe('fr.emse.canari');
    expect(swiftLet('keychainService')).toBe(rustConst('KEYCHAIN_SERVICE'));
    expect(swiftLet('keychainAccount')).toBe(rustConst('KEYCHAIN_ACCOUNT'));
    expect(rust).toContain('const ACCESS_GROUP: &str = "group.fr.emse.canari"');
    expect(swift).toContain('static let appGroupId = "group.fr.emse.canari"');
  });

  it('reads the mailbox and the inbox the page reads', () => {
    expect(swiftLet('soapUrl')).toBe(`https://${MAIL_HOST}/service/soap`);
    expect(swiftLet('inboxFolderId')).toBe(INBOX_FOLDER_ID);
  });

  it('shares the cursor file the app writes', () => {
    expect(watch).toContain('MAIL_WATCH_DIR: &str = "mail_watch"');
    expect(watch).toContain('format!("cursor_{user_id}.json")');
    expect(swift).toContain('appendingPathComponent("mail_watch", isDirectory: true)');
    expect(swift).toContain('"cursor_\\(secret.userId).json"');
  });

  it('the remote forget is the type the server sends', () => {
    const server = readFileSync(
      resolve(root, '../../apps/chat-delivery-service/src/utils/mail-forget.ts'),
      'utf8'
    );
    expect(server).toContain("MAIL_FORGET_TYPE = 'mail-forget'");
    expect(objc).toContain('isEqualToString:@"mail-forget"');
    expect(objc).toContain('canari_mail_forget(');
    const kotlin = readFileSync(
      resolve(root, 'gen/android/app/src/main/java/fr/emse/canari/mail/MailPush.kt'),
      'utf8'
    );
    expect(kotlin).toContain('const val MAIL_FORGET_TYPE = "mail-forget"');
    expect(kotlin).toContain('const val MAIL_PUSH_TYPE = "mail"');
  });
});

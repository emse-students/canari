/**
 * The iOS tap target of a message or salon notification does not depend on the notification
 * extension having run (P1 of 2026-11-01).
 *
 * The server's MLS and salon pushes carry no `deepLink`; the extension writes one. When it did not
 * run, the tap opened the app on nothing although `groupId` / `channelId` were in the payload.
 * Objective-C++ compiles only on the macOS runner, so the contract is pinned on the source.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const APPLE = resolve(here, '../../../src-tauri/gen/apple');
const push = readFileSync(resolve(APPLE, 'Sources/canari/canari_push.mm'), 'utf8');
const nse = readFileSync(resolve(APPLE, 'canari_NSE/NotificationService.swift'), 'utf8');

describe('the iOS notification tap', () => {
  it('opens the link through CanariTapDeepLink, never userInfo["deepLink"] alone', () => {
    const handler = push.slice(push.indexOf('didReceiveNotificationResponse:'));
    expect(handler).toContain('NSString *deepLink = CanariTapDeepLink(userInfo);');
  });

  it('derives the same links the extension writes, from the clear fields', () => {
    const fn = push.slice(
      push.indexOf('static NSString *_Nullable CanariTapDeepLink'),
      push.indexOf('static NSString *_Nullable CanariTapDeepLink') + 2400
    );
    expect(fn).toContain('@"fr.emse.canari://chat/channel_%@", channelId');
    expect(fn).toContain('@"fr.emse.canari://chat/%@", groupId');
    // The extension's own spellings of the same two links.
    expect(nse).toContain('"fr.emse.canari://chat/\\(groupId)"');
    expect(nse).toContain('"fr.emse.canari://chat/channel_\\(channelId)"');
  });

  it('prefers a link the payload carries', () => {
    const fn = push.slice(push.indexOf('static NSString *_Nullable CanariTapDeepLink'));
    expect(fn.indexOf('userInfo[@"deepLink"]')).toBeLessThan(fn.indexOf('userInfo[@"groupId"]'));
  });
});

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
const ID_RE = '^[A-Za-z0-9_-]{1,128}$';

function tapFn(): string {
  const start = push.indexOf('static NSString *_Nullable CanariTapDeepLink');
  return push.slice(start, push.indexOf('\n}\n', start));
}

describe('the iOS notification tap', () => {
  it('opens the link through CanariTapDeepLink, never userInfo["deepLink"] alone', () => {
    const handler = push.slice(push.indexOf('didReceiveNotificationResponse:'));
    expect(handler).toContain('NSString *deepLink = CanariTapDeepLink(userInfo);');
  });

  it('derives the same links the extension writes, from the clear fields', () => {
    const fn = tapFn();
    expect(fn).toContain('CanariChatLink(channelId, @"channel_")');
    expect(fn).toContain('CanariChatLink(groupId, @"")');
    // The extension's own spellings of the same two links.
    expect(nse).toContain('Self.chatLink(groupId)');
    expect(nse).toContain('Self.chatLink(channelId, prefix: "channel_")');
    expect(push).toContain('@"fr.emse.canari://chat/%@%@", prefix, value');
    expect(nse).toContain('"fr.emse.canari://chat/\\(prefix)\\(id)"');
  });

  it('prefers a link the payload carries, and only one of this app', () => {
    const fn = tapFn();
    expect(fn.indexOf('userInfo[@"deepLink"]')).toBeLessThan(fn.indexOf('userInfo[@"groupId"]'));
    expect(fn).toContain('[c.scheme isEqualToString:@"fr.emse.canari"]');
    // A refused link is logged by its shape, never verbatim.
    expect(fn).toContain('CanariDescribeDeepLink(link)');
  });
});

describe('a chat link is built from an id only', () => {
  it('checks the same id pattern on both sides', () => {
    expect(push).toContain(`@"${ID_RE}"`);
    expect(nse).toContain(`"${ID_RE}"`);
  });

  it('builds no chat link from a raw interpolation anywhere', () => {
    // Every construction goes through CanariChatLink / chatLink, which hold the only format string.
    expect(push.match(/fr\.emse\.canari:\/\/chat\/[^"]*%@/g)).toEqual([
      'fr.emse.canari://chat/%@%@',
    ]);
    expect(nse.match(/fr\.emse\.canari:\/\/chat\/[^"]*?\\\(/g)).toEqual([
      'fr.emse.canari://chat/\\(',
    ]);
  });

  it('accepts every id this app mints and refuses a route-shaped one', () => {
    const re = new RegExp(ID_RE);
    expect(re.test('3f2b8c1e-9a4d-4e7f-b6c2-0d1e2f3a4b5c')).toBe(true);
    expect(re.test('channel_abc')).toBe(true);
    for (const bad of ['', 'a/b', '../x', 'a?b=1', 'a#b', 'x'.repeat(129)]) {
      expect(re.test(bad), bad).toBe(false);
    }
  });
});

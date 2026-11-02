import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A SILENT (`content-available`) FRAME MUST REACH CANARI CODE ON iOS, AND MAY DO ONLY WHAT AN
 * ALLOWLIST SAYS (docs/wiki/frontend/mobile.md, the silent-frame section).
 *
 * The hook used to REPLACE an existing `application:didReceiveRemoteNotification:
 * fetchCompletionHandler:` and returned when there was none - which is every launch, because wry's
 * delegate does not implement it. So `channel_read` (a salon read on another of my devices) never
 * dismissed anything on an iPhone (iPhone 12 syslog, 2026-10-15). The method is now ADDED.
 *
 * Adding it is what makes the allowlist load-bearing: a woken process must not run the join and
 * Welcome-answer branches of `CanariHandleFcmData` - MLS writes no iPhone has ever run in the
 * background. Objective-C++ is compiled only on the macOS runner, so this reads the source.
 */
const APPLE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src-tauri/gen/apple');
const mm = readFileSync(resolve(APPLE, 'Sources/canari/canari_push.mm'), 'utf8');

/** The body of the first C function whose signature starts with `signature`, braces balanced. */
function body(signature: string): string {
  const start = mm.indexOf(signature);
  expect(start, `${signature} introuvable dans canari_push.mm`).toBeGreaterThanOrEqual(0);
  const open = mm.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < mm.length; i++) {
    if (mm[i] === '{') depth++;
    else if (mm[i] === '}' && --depth === 0) return mm.slice(open, i + 1);
  }
  throw new Error(`${signature}: accolades non equilibrees`);
}

describe('iOS silent frames', () => {
  it('the hook ADDS the delegate method rather than requiring one to exist', () => {
    const install = body('static BOOL CanariInstallRemoteNotificationHook(');
    expect(install).toContain('class_replaceMethod(');
    expect(install).toContain('application:didReceiveRemoteNotification:fetchCompletionHandler:');
    // The old guard: no method on the delegate -> return, i.e. never installed.
    expect(install).not.toContain('class_getInstanceMethod');
  });

  it('UIKit is told about the added method: the delegate is re-assigned once it is in', () => {
    expect(body('static void CanariReassignAppDelegate(')).toMatch(
      /app\.delegate = nil;\s*app\.delegate = delegate;/
    );
    expect(body('void CanariPushSetup(')).toMatch(
      /CanariInstallRemoteNotificationHook\(\);[\s\S]*if \(added\) \{\s*CanariReassignAppDelegate\(\);/
    );
  });

  it('only a silent frame is acted on, and the completion handler is called once at the end', () => {
    const hook = body('static void CanariSwizzledDidReceiveRemoteNotification(');
    expect(hook).toContain('CanariIsSilentFrame(userInfo)');
    expect(hook).toContain('CanariHandleBackgroundFrame(data, merge)');
    expect(hook).toMatch(/dispatch_group_notify\([\s\S]*completionHandler\(result\)/);
    expect(hook.match(/completionHandler\(/g)).toHaveLength(1);
  });

  it('a woken process dismisses and writes no MLS state (the allowlist)', () => {
    const frame = body('static void CanariHandleBackgroundFrame(');
    expect(frame).toContain('@"channel_read"');
    expect(frame).toContain('CanariCancelConversationNotification(conversationId');
    for (const forbidden of [
      'CanariHandleFcmData',
      'CanariHandleMlsMessage',
      'CanariProcessReceivedWelcomeBackground',
      'CanariProcessWelcomeRequestBackground',
      'CanariTryDecrypt',
    ]) {
      expect(frame, `${forbidden} appele depuis un reveil en arriere-plan`).not.toContain(
        forbidden
      );
    }
  });

  it('a silent wake-up is fetched and handed back to the same allowlist, writing no MLS state', () => {
    const frame = body('static void CanariHandleBackgroundFrame(');
    expect(frame).toContain('CanariHandleWakeBackgroundFrame(data, done);');
    const wake = body('static void CanariHandleWakeBackgroundFrame(NSDictionary *data, void');
    expect(wake).toContain('/api/mls/push/wake');
    expect(wake).toContain('CanariHandleBackgroundFrame(fields, done);');
    for (const forbidden of [
      'CanariHandleFcmData',
      'CanariHandleMlsMessage',
      'CanariProcessReceivedWelcomeBackground',
      'CanariProcessWelcomeRequestBackground',
      'CanariTryDecrypt',
    ]) {
      expect(wake, `${forbidden} appele depuis un reveil sans contenu`).not.toContain(forbidden);
    }
  });

  it('channel_read has ONE handler, the background one', () => {
    expect(body('static void CanariHandleFcmData(')).not.toContain('@"channel_read"');
  });
});

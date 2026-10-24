import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The iPhone's native ring, read as TEXT (WP-C6, `docs/wiki/frontend/modules/calls.md`, "The native
 * ring on the iPhone"). Nothing on this machine compiles Objective-C: this proves what is written,
 * never what runs - the iOS CI job compiles it, and K6/K7/K8 on the iPhone are what run it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pushMm = readFileSync(
  resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_push.mm'),
  'utf8'
);

/** The body of the PushKit delivery handler, from its selector to the end of the method. */
function voipHandler(): string {
  const start = pushMm.indexOf('didReceiveIncomingPushWithPayload:(PKPushPayload *)payload');
  expect(start, 'the PushKit delivery handler').toBeGreaterThan(0);
  const end = pushMm.indexOf('\n}\n', start);
  return pushMm.slice(start, end);
}

describe('the VoIP push handler (Apple: every VoIP push reports a CallKit call)', () => {
  it('reports on every branch (signed out, ring, unexpected payload), and only then completes', () => {
    const body = voipHandler();
    const reports = [...body.matchAll(/CanariReportVoipCall\(/g)].length;
    expect(reports, 'a report on the signed-out, ring AND unexpected-payload branches').toBe(3);
    expect(body.lastIndexOf('CanariReportVoipCall(')).toBeLessThan(body.indexOf('completion();'));
    // Synchronous: a completion dispatched later could run before a report queued behind it.
    expect(body).not.toMatch(/dispatch_async[\s\S]*completion\(\)/);
  });

  it('reads no name from the push - the payload names nobody (decision 6)', () => {
    const body = voipHandler();
    for (const key of ['callerName', 'senderName', 'groupName']) {
      expect(body, key).not.toContain(`@"${key}"`);
    }
    expect(body).toContain('@"callerId"');
    expect(body).toContain('@"ringUntil"');
  });

  it("names the caller from the phone's copy, and neutrally when it has none", () => {
    const fn = pushMm.slice(pushMm.indexOf('static NSString *CanariCallerDisplayName('));
    expect(fn).toMatch(/CanariLoadMentionNames\(/);
    expect(fn).toContain('notif.call.unknown_caller');
  });

  it('never announces video on the native ring', () => {
    const fn = pushMm.slice(
      pushMm.indexOf('static void CanariReportVoipCall('),
      pushMm.indexOf('static void CanariPersistVoipToken(')
    );
    expect(fn).toContain('update.hasVideo = NO;');
    expect(fn).not.toMatch(/update\.hasVideo = (YES|hasVideo)/);
  });
});

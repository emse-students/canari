import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE BLANK ROW A WITHHELD TREND LEAVES ON iOS IS REMOVED BY THE APP (owner, 2026-11-24, review of
 * #4065). The extension cannot drop an alert push without Apple's filtering entitlement, so it stamps
 * its blank content `canariWithheld` = `seen-trend`, and the app deletes every delivered notification
 * carrying the stamp. Nothing compiles the two spellings against each other: this pins them, and pins
 * the two moments the cleanup runs (every foreground, and whenever the process runs for a push).
 */
const here = dirname(fileURLToPath(import.meta.url));
const apple = '../../../src-tauri/gen/apple/';
const nse = readFileSync(resolve(here, `${apple}canari_NSE/NotificationService.swift`), 'utf8');
const push = readFileSync(resolve(here, `${apple}Sources/canari/canari_push.mm`), 'utf8');

describe('the blank notification of a withheld trend is cleaned up by the app', () => {
  it('is stamped by the extension and recognised by the app on the same key and value', () => {
    expect(nse).toContain('info["canariWithheld"] = "seen-trend"');
    expect(push).toContain('n.request.content.userInfo[@"canariWithheld"]');
    expect(push).toContain('isEqualToString:@"seen-trend"');
  });

  it('runs at every foreground and when the process runs for a push or a silent frame', () => {
    const calls = push.match(/CanariRemoveWithheldTrendNotifications\(\);/g) ?? [];
    expect(calls).toHaveLength(3);
    const activation = push.indexOf('CanariCheckNotificationDelegate(@"activation");');
    expect(push.slice(activation, activation + 200)).toContain(
      'CanariRemoveWithheldTrendNotifications();'
    );
    const background = push.indexOf('static void CanariHandleBackgroundFrame(');
    expect(push.slice(background, background + 900)).toContain(
      'CanariRemoveWithheldTrendNotifications();'
    );
    const handler = push.indexOf('static void CanariHandleFcmData(NSDictionary *data) {');
    expect(push.slice(handler, handler + 900)).toContain(
      'CanariRemoveWithheldTrendNotifications();'
    );
  });
});

/**
 * EVERY END OF THE SEEN-TREND DECISION IS NAMED ON iOS TOO (1.8.3-alpha.1, Mi 9T: a trend push named
 * no post and the rule answered a bare false, logged by nobody). The Swift contract test is not wired
 * to a target and Windows compiles neither reader, so this pins each `reason` of the shared contract
 * to both iOS spellings - the Swift enum and the ObjC verdict - and the accusing WARN to both.
 */
describe('the iOS readers name every end of the decision the contract names', () => {
  const contract = JSON.parse(
    readFileSync(
      resolve(here, '../../../../libs/contracts/notification-seen-trend.cases.json'),
      'utf8'
    )
  ) as { cases: { reason: string }[] };
  const reasons = [...new Set(contract.cases.map((c) => c.reason)), 'no-record'];

  it.each(reasons)('%s', (reason) => {
    expect(push).toContain(`@"${reason}"`);
    const swiftCase = reason.includes('-') ? `= "${reason}"` : `case ${reason}\n`;
    expect(nse).toContain(swiftCase);
  });

  it('a trend that names no post accuses the payload on both', () => {
    expect(nse).toContain('[SEEN_TREND] WARN a campus trend names no postId');
    expect(push).toContain('[SEEN_TREND] WARN a campus trend names no postId');
  });
});

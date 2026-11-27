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
 * to a target and Windows compiles neither reader, so this reads the two DECLARATIONS - the Swift
 * enum's cases with their raw values, the ObjC verdict's `return @"..."` - comments stripped, and
 * holds each to the contract's reasons: a word in a comment satisfies nothing.
 */
describe('the iOS readers name every end of the decision the contract names', () => {
  const contract = JSON.parse(
    readFileSync(
      resolve(here, '../../../../libs/contracts/notification-seen-trend.cases.json'),
      'utf8'
    )
  ) as { cases: { reason: string }[] };
  // `no-record` (no file) is no case: every case reads the contract's book.
  const reasons = new Set([...contract.cases.map((c) => c.reason), 'no-record']);

  /** The body of the block opened by `head`, line comments removed. */
  const blockOf = (src: string, head: string): string => {
    const start = src.indexOf(head);
    expect(start, head).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) {
        return src.slice(src.indexOf('{', start) + 1, i).replace(/\/\/.*$/gm, '');
      }
    }
    throw new Error(`unclosed block: ${head}`);
  };

  it('the Swift enum: each case, by its raw value', () => {
    const body = blockOf(nse, 'enum SeenTrendVerdict: String {');
    const raw = [...body.matchAll(/^\s*case\s+(\w+)(?:\s*=\s*"([^"]+)")?\s*$/gm)].map(
      ([, name, value]) => value ?? name
    );
    expect(new Set(raw)).toEqual(reasons);
    expect(raw).toHaveLength(reasons.size);
  });

  it('the ObjC verdict: each word it returns', () => {
    const body = blockOf(push, 'static NSString *CanariSeenTrendVerdict(');
    const returned = [...body.matchAll(/return\s+@"([^"]+)";/g)].map(([, word]) => word);
    expect(new Set(returned)).toEqual(reasons);
  });

  it('a trend that names no post accuses the server on both, at their error level', () => {
    expect(blockOf(nse, 'static func withholdsSeenTrend(')).toMatch(
      /NseLog\.log\.error\(\s*"\[CanariNSE\] \[SEEN_TREND\] ERROR a campus trend names no postId/
    );
    expect(blockOf(push, 'static BOOL CanariWithholdsSeenTrend(')).toMatch(
      /NSLog\(@"\[CanariPush\] \[SEEN_TREND\] ERROR a campus trend names no postId/
    );
  });
});

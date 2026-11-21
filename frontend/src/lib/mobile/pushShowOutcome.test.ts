import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactLogLine } from '$lib/utils/appLogRedact';

/**
 * EVERY END OF A VISIBLE MESSAGE PUSH SAYS WHICH ONE IT WAS, IN THE IN-APP LOG (2026-11-20).
 *
 * A message push could be cached and draw nothing - by design, or because the OS dropped what the
 * app posted - and each case was a logcat `Log.d`, so a member's exported log could not tell them
 * apart. Each end now records ONE `[PUSH_SHOW]` line (`PushShowOutcome.kt`; the JVM test
 * `PushShowOutcomeTest` pins its wording and level). This pins the wiring: a new return in the show
 * decision that forgets the line - the silence this closed - fails here. See
 * `docs/wiki/frontend/mobile.md`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = resolve(here, '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari');
const service = readFileSync(resolve(ANDROID, 'CanariFirebaseMessagingService.kt'), 'utf8');
const nativeLog = readFileSync(resolve(ANDROID, 'NativePushLog.kt'), 'utf8');

/** The body of the function whose declaration is `header`, braces matched from `opener`. */
function bodyOf(source: string, header: string, opener: string): string {
  const at = source.indexOf(header);
  expect(at, `${header} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf(opener, at) + opener.length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${header}: unbalanced braces`);
}

/** Kotlin without its comments - a `return` or a record named in prose is not code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A return of the function itself, anywhere on a line (`?: return`, `-> return`), never `return@`. */
const RETURN = /\breturn\b(?!@)/g;
const RECORD = /\brecordShowOutcome\(/g;

const show = code(bodyOf(service, 'internal fun Context.showMessageNotification(', '): Long {'));

/** The statement just before `index` in `lines`, blank lines and `Log.` lines aside. */
function statementBefore(lines: string[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l !== '' && !l.startsWith('Log.')) return l;
  }
  return '';
}

describe('showMessageNotification records exactly one outcome per return', () => {
  // A direct record before an early return, or `ended = ...` inside the section held under
  // READ_ELSEWHERE's lock, which the `finally` records once the lock is released.
  const ENDED = /\bended = PushShowOutcome\./g;
  const direct = (show.match(RECORD) ?? []).length - 1; // minus the `finally`'s own record

  it('counts as many ends as returns: one record or one `ended =` per return', () => {
    const returns = show.match(RETURN) ?? [];
    const ended = show.match(ENDED) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(6);
    expect(direct + ended.length).toBe(returns.length);
  });

  it('every return is preceded by its own record or `ended =`', () => {
    const lines = show.split('\n');
    lines.forEach((l, i) => {
      if (!/\breturn\b(?!@)/.test(l)) return;
      const before = statementBefore(lines, i);
      // `return postedStamp` follows the `finally` that records the post.
      if (/\breturn postedStamp\b/.test(l)) return;
      expect(before, `nothing recorded before "${l.trim()}"`).toMatch(
        /^(recordShowOutcome\(|ended = PushShowOutcome\.|endedDetail = )/
      );
    });
  });

  it("records the locked section's end in a finally, once the lock is released", () => {
    expect(show).toMatch(
      /\} \} finally \{\s*ended\?\.let \{ recordShowOutcome\(it, groupId, channel, manager, endedShortcut, endedDetail\) \}/
    );
    expect(show).toContain(
      'ended = PushShowOutcome.posted(alreadyPosted, supersedes != 0L, callHolds)'
    );
    // The post is decided after the notify, and recorded before the badge summary.
    const notify = show.indexOf('manager.notify(notifId, notif)');
    const posted = show.indexOf('PushShowOutcome.posted(');
    expect(posted).toBeGreaterThan(notify);
    expect(show.indexOf('} } finally {')).toBeLessThan(show.indexOf('refreshBadgeSummary('));
  });

  it('each suppression names its own outcome', () => {
    for (const outcome of ['SUPPRESSED_FOREGROUND', 'SUPPRESSED_SHADE_MARK']) {
      expect(show).toContain(
        `recordShowOutcome(PushShowOutcome.Outcome.${outcome}, groupId, channel)`
      );
    }
    expect(show).toContain(
      'recordShowOutcome(PushShowOutcome.Outcome.SUPPRESSED_READ_ELSEWHERE, groupId, channel, detail = "early")'
    );
    expect(show).toContain('ended = PushShowOutcome.Outcome.SUPPRESSED_ALREADY_ALERTED');
    expect(show).toContain('ended = PushShowOutcome.Outcome.SUPPRESSED_READ_ELSEWHERE');
  });
});

describe('every read-elsewhere decision records its outcome, outside the lock', () => {
  const svc = code(service);

  it('a read and a dismissal record what they did to the banner, in a finally', () => {
    const cancel = code(bodyOf(service, 'internal fun cancelConversationNotification(', ') {'));
    expect(cancel).toContain('decided = PushShowOutcome.of(outcome)');
    expect(cancel).toContain('decided = PushShowOutcome.of(withdrawal)');
    expect(cancel).toMatch(
      /\} \} finally \{\s*decided\?\.let \{ context\.recordShowOutcome\(it, groupId, null, manager\) \}/
    );
  });

  it('a delivered reply and an answered reply record what they did to the banner', () => {
    expect(svc).toContain(
      'context.recordShowOutcome(PushShowOutcome.of(outcome), groupId, null, manager, detail = "by=reply-delivered")'
    );
    expect(svc).toContain(
      'context.recordShowOutcome(PushShowOutcome.of(outcome), groupId, null, manager, detail = "by=answer-reply")'
    );
    // The answer's record follows its locked section, never inside it.
    const answer = code(bodyOf(service, 'internal fun answerReplyNotification(', ') {'));
    const lockEnd = answer.indexOf('.also { cancelReactionNotification(prefs, manager, groupId) }');
    expect(answer.indexOf('recordShowOutcome(')).toBeGreaterThan(lockEnd);
  });

  it("holdsDirectReply's answer for a post is carried on its line", () => {
    expect(svc).toContain('if (heldByReply) endedDetail = "heldByReply=true"');
  });
});

describe('every earlier end of a visible message push records its outcome', () => {
  const svc = code(service);

  /** The `if (...)` block at `marker`, braces matched. */
  function blockAt(marker: string): string {
    const at = svc.indexOf(marker);
    expect(at, `${marker} not found`).toBeGreaterThanOrEqual(0);
    return bodyOf(svc.slice(at), marker, '{');
  }

  it.each([
    [
      'the dispatchPush foreground guard',
      'if (MainActivity.isInForeground && !ForegroundGuard.actsInForeground(msgType, isReaction))',
      'SUPPRESSED_FOREGROUND_GUARD',
    ],
    [
      'the wake foreground guard',
      'if (MainActivity.isInForeground) {\n            Log.d(TAG, "[PUSH_WAKE]',
      'SUPPRESSED_FOREGROUND_WAKE',
    ],
    ['a decrypt yielded to the foreground', 'if (outcome is PushDecrypt.Yielded)', 'YIELDED'],
    [
      'a level that withholds it (cached, no banner)',
      'if (gate is NotificationLevelGate.Decision.Withhold)',
      'WITHHELD_LEVEL',
    ],
    [
      'a refusal the real banner covers',
      'if (refusedForGood && GENERIC_BANNERS.refusedCoveredByRealPost(groupId))',
      'REFUSED_COVERED',
    ],
  ])('%s', (_name, marker, outcome) => {
    const block = blockAt(marker);
    expect(block).toContain(`PushShowOutcome.Outcome.${outcome}`);
    expect(block.match(RECORD)).toHaveLength(1);
    // The record is the block's last statement before its return, if it returns.
    const ret = block.search(RETURN);
    if (ret >= 0) expect(block.indexOf('recordShowOutcome(')).toBeLessThan(ret);
  });

  it('the withheld line says whether the message was cached, and why it was withheld', () => {
    expect(blockAt('if (gate is NotificationLevelGate.Decision.Withhold)')).toContain(
      'detail = "cached=${decrypted != null} ${gate.reason}"'
    );
  });
});

describe('the recorded line', () => {
  it('is a recorded INFO by design, a WARN when the OS drops a post, logcat only when not recorded', () => {
    expect(service).toContain('!outcome.recorded -> Log.d(TAG, line)');
    expect(service).toContain("PushShowOutcome.level(outcome, os) == 'W' -> Log.w(TAG, line)");
    expect(service).toContain('else -> Log.iRecorded(TAG, line)');
    // The deliberate path passes the level gate on purpose, into its own stream; a plain i does not.
    expect(nativeLog).toMatch(
      /fun iRecorded\(tag: String, msg: String\): Int \{\s*NativePushLog\.recordInfo\(tag, msg\)/
    );
    expect(nativeLog).toMatch(/fun i\(tag: String, msg: String\): Int = Log\.i\(tag, msg\)/);
    expect(nativeLog).toContain("line, level == 'I')");
  });

  it('reads the conversation channel and the paused state', () => {
    expect(service).toContain('manager.getNotificationChannel(id, it)');
    expect(service).toContain('manager.areNotificationsPaused()');
  });

  it('survives the in-app log redaction whole: its fields are system words, not values it hides', () => {
    const line =
      '[NATIVE_PUSH] 2026-11-20 17:04:00.000 I CanariFCM: [PUSH_SHOW] outcome=withheld-level conv=g:0a1b2c3d channel=? ' +
      'os: enabled=true paused=false importance=? dnd=all bucket=rare powerSave=false ' +
      'why: cached=true level=mentions and the message does not mention this account';
    expect(redactLogLine(line).line).toBe(line);
    const salon =
      '[PUSH_SHOW] outcome=posted conv=ch:9f8e7d6c channel=canari_messages_v2 os: enabled=false';
    expect(redactLogLine(salon).line).toBe(salon);
  });
});

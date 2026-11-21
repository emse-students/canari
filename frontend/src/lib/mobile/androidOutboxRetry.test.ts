import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE BACKGROUND OUTBOX RETRY ENDS ON DURABLE STATE, NEVER ON A COUNT (#3912 review, rounds 11-12).
 *
 * The decisions are tested on the JVM (`OutboxRetryTest`, `QueuedSendAnswerTest`); this pins the
 * wiring no JVM test reaches: the drain answering why each entry remains, the worker deciding on it
 * with no cap, a run in front ending its request, and the background edge enqueueing the next.
 * Mechanism: docs/wiki/frontend/mobile.md, "The retry ends on durable state, never on a count".
 */
const here = dirname(fileURLToPath(import.meta.url));
const JAVA = resolve(here, '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari');
const service = readFileSync(resolve(JAVA, 'CanariFirebaseMessagingService.kt'), 'utf8');
const worker = readFileSync(resolve(JAVA, 'OutboxRetryWorker.kt'), 'utf8');
const activity = readFileSync(resolve(JAVA, 'MainActivity.kt'), 'utf8');

describe('the outbox retry', () => {
  it('drains through the typed drain and decides on its leftovers, with no count', () => {
    expect(worker).toContain(
      'CanariFirebaseMessagingService.drainOutbox(applicationContext, service, ctx)'
    );
    expect(worker).toContain('when (OutboxRetry.decide(left))');
    expect(worker).not.toMatch(/MAX_DRAIN_ATTEMPTS|recordAttempt/);
  });

  it('deletes the attempt counts of the capped builds at every run start, logged', () => {
    const run = worker.slice(worker.indexOf('override fun doWork(): Result {'));
    expect(run.indexOf('forgetLegacyAttemptCounts(applicationContext)')).toBeLessThan(
      run.indexOf('OutboxRetry.run(')
    );
    expect(worker).toContain('private const val LEGACY_ATTEMPTS_PREFIX = "drain_attempts_"');
    expect(worker).toContain('attempt count(s) of the capped builds deleted');
  });

  it('posts no nudge for an erased account - nothing to open the app for', () => {
    const absent = worker.slice(
      worker.indexOf('if (ctxRead.verdict == PushContextVerdict.Absent) {')
    );
    const branch = absent.slice(0, absent.indexOf('return Result.success()'));
    expect(branch).toContain('Log.w(TAG, "doWork: push_context.json absent');
    expect(branch).not.toContain('giveUp()');
  });

  it('marks an entry that will never go, skips it, and never drops it', () => {
    const drain = service.slice(service.indexOf('private fun drainOutboxLocked('));
    expect(drain).toContain('val parked = mirror.filter { it.unsendable }');
    expect(drain).toContain('val entries = mirror.filterNot { it.unsendable }');
    expect(drain).toContain(
      'rewriteOutboxMirror(context, parked + remaining + entries.drop(index))'
    );
    expect(drain).toContain('val stillQueued: List<OutboxMirrorEntry> = parked + remaining');
    expect(drain).toContain('entry.copy(unsendable = true)');
    expect(service).toContain('if (e.unsendable) put("unsendable", true)');
    expect(service).toContain('o.optBoolean("unsendable", false)');
    // Told: the drain that marked it asks for the nudge.
    expect(service).toContain(
      'settleOutboxNudgeLocked(context, asked = tells, where = "drainOutboxBackground")'
    );
  });

  it('reads the native batch prospect token, never its prose', () => {
    expect(service).toContain('OutboxRetry.Prospect.of(json.optString("prospect")');
    expect(service).toContain('OutboxRetry.Prospect.of(r.optString("prospect")');
  });

  it('ends a run in front with success, never a retry that grows the backoff', () => {
    const front = worker.slice(worker.indexOf('OutboxRetry.Run.END_FOR_PAGE -> {'));
    expect(front.slice(0, front.indexOf('}'))).toContain('return Result.success()');
  });

  it('hands the outbox back to the worker when the app leaves the front', () => {
    const pause = activity.slice(activity.indexOf('override fun onPause()'));
    expect(pause.slice(0, pause.indexOf('\n    }\n'))).toContain(
      'OutboxRetryWorker.enqueueIfMirrorHolds(appContext)'
    );
  });

  it('keeps a POST that failed with WHY, classified where the answer is read', () => {
    expect(service).toContain('prospects.add(answer.cause.prospect)');
    expect(service).toContain(
      'QueuedSendAnswer.Outcome.Kept(QueuedSendAnswer.KeptCause.TRANSPORT_FAILED)'
    );
    expect(service).toContain('return List(entries.size) { OutboxRetry.Prospect.BLOCKED }');
    expect(service).toContain('QueuedSendAnswer.classify(code, readRefusal)');
  });
});

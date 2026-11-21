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
    expect(worker).not.toMatch(/MAX_DRAIN_ATTEMPTS|recordAttempt|drain_attempts_/);
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
    expect(service).toContain('return List(entries.size) { OutboxRetry.Prospect.NEVER }');
  });
});

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE "MESSAGES EN ATTENTE" NUDGE FOLLOWS THE OUTBOX MIRROR, UNDER ITS OWN ID.
 *
 * Seen on the Mi 9T, 2026-11-21: a quick reply queued offline was delivered by the retry worker and
 * the nudge stayed in the shade until the app opened - every drain that left sends posted it, and no
 * path withdrew it. And its id, 9998, was also the background worker's foreground notice, so a blind
 * cancel would have taken that down. The decision itself is tested on the JVM (`OutboxNudgeTest`);
 * this pins the wiring no JVM test reaches: who posts, who cancels, and under which lock.
 * Mechanism: docs/wiki/frontend/mobile.md, "The outbox nudge".
 */
const here = dirname(fileURLToPath(import.meta.url));
const JAVA = resolve(here, '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari');
const service = readFileSync(resolve(JAVA, 'CanariFirebaseMessagingService.kt'), 'utf8');
const worker = readFileSync(resolve(JAVA, 'MlsBackgroundWorker.kt'), 'utf8');
const retry = readFileSync(resolve(JAVA, 'OutboxRetryWorker.kt'), 'utf8');
const fixed = readFileSync(resolve(JAVA, 'push/FixedNotifIds.kt'), 'utf8');

/** The body of the function whose declaration starts with [signature], up to the next declaration. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\n        /**', start);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('the outbox nudge', () => {
  it('has its own fixed id, and the worker keeps 9998', () => {
    expect(fixed).toContain('const val OUTBOX_NUDGE = 999\n');
    expect(fixed).toContain('const val WORKER_FOREGROUND = 9998\n');
    expect(fixed).not.toMatch(/\bPENDING_SYNC\b/);
    expect(service).toContain(
      'private const val OUTBOX_NUDGE_NOTIF_ID = FixedNotifIds.OUTBOX_NUDGE'
    );
    expect(worker).toContain(
      'private const val FOREGROUND_NOTIF_ID = fr.emse.canari.push.FixedNotifIds.WORKER_FOREGROUND'
    );
  });

  it('is posted in one place and cancelled in one place, both under the outbox lock', () => {
    // One `notify` and one `cancel` on its id in the whole service.
    expect(service.match(/manager\.notify\(OUTBOX_NUDGE_NOTIF_ID,/g)).toHaveLength(1);
    expect(service.match(/manager\.cancel\(OUTBOX_NUDGE_NOTIF_ID\)/g)).toHaveLength(1);
    expect(body(service, 'private fun postOutboxNudge(')).toContain(
      'manager.notify(OUTBOX_NUDGE_NOTIF_ID, notif)'
    );
    const settle = body(service, 'private fun settleOutboxNudgeLocked(');
    expect(settle).toContain('val queued = readOutboxMirrorOrNull(context)?.size');
    expect(settle).toContain('OutboxNudge.decide(queued, asked)');
    expect(settle).toContain('manager.cancel(OUTBOX_NUDGE_NOTIF_ID)');
    expect(settle).toContain('postOutboxNudge(context, manager)');
    // Only the settle posts.
    expect(service.match(/postOutboxNudge\(context, manager\)/g)).toHaveLength(1);
    // The ask takes the lock and goes through the settle.
    const ask = body(service, 'internal fun showPendingSyncNotification(context: Context)');
    expect(ask).toContain('synchronized(OUTBOX_LOCK) {');
    expect(ask).toContain('settleOutboxNudgeLocked(context, asked = true,');
  });

  it('is withdrawn by every drain, inside the lock that rewrote the mirror', () => {
    const drain = body(service, 'internal fun drainOutboxBackground(');
    const locked = drain.slice(drain.indexOf('synchronized(OUTBOX_LOCK) {'));
    const settleAt = locked.indexOf('settleOutboxNudgeLocked(context, asked = false,');
    expect(settleAt).toBeGreaterThan(locked.indexOf('drainOutboxLocked('));
    // Before the block's result, so still inside it.
    expect(settleAt).toBeLessThan(locked.indexOf('\n                left\n'));
  });

  it('is withdrawn by the retry worker when it finds the outbox empty', () => {
    const empty = retry.slice(retry.indexOf('if (queued == 0) {'));
    expect(empty.slice(0, 600)).toContain(
      'CanariFirebaseMessagingService.settleOutboxNudge(applicationContext, "OutboxRetryWorker")'
    );
  });

  it('withdraws a pre-update nudge under 9998 only when the record is not the worker notice', () => {
    const legacy = body(service, 'private fun withdrawPreUpdateNudge(');
    expect(legacy).toContain('Notification.FLAG_ONGOING_EVENT');
    expect(legacy).toContain('Notification.FLAG_FOREGROUND_SERVICE');
    const guard = legacy.indexOf('OutboxNudge.isPreUpdateNudge(');
    const cancel = legacy.indexOf('manager.cancel(FixedNotifIds.WORKER_FOREGROUND)');
    expect(guard).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(guard);
    // The only cancel of the worker's id anywhere in the service.
    expect(service.match(/cancel\(FixedNotifIds\.WORKER_FOREGROUND\)/g)).toHaveLength(1);
  });
});

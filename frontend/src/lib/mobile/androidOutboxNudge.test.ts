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
 * cancel would have taken that down; it has its own id since 1.7.3. The decision itself is tested on the JVM (`OutboxNudgeTest`);
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
    expect(settle).toContain('withdrawOutboxNudge(manager, where)');
    expect(settle).toContain('postOutboxNudge(context, manager)');
    // Only the withdrawal cancels.
    expect(body(service, 'private fun withdrawOutboxNudge(')).toContain(
      'manager.cancel(OUTBOX_NUDGE_NOTIF_ID)'
    );
    // Only the settle posts.
    expect(service.match(/postOutboxNudge\(context, manager\)/g)).toHaveLength(1);
    // The ask takes the lock and goes through the settle.
    const ask = body(service, 'internal fun showPendingSyncNotification(context: Context)');
    expect(ask).toContain('synchronized(OUTBOX_LOCK) {');
    expect(ask).toContain('settleOutboxNudgeLocked(context, asked = true,');
  });

  it('is withdrawn by every drain, inside the lock that rewrote the mirror', () => {
    const drain = body(service, 'internal fun drainOutbox(');
    const locked = drain.slice(drain.indexOf('synchronized(OUTBOX_LOCK) {'));
    const settleAt = locked.indexOf('settleOutboxNudgeLocked(context, asked = tells,');
    expect(settleAt).toBeGreaterThan(locked.indexOf('drainOutboxLocked('));
    // Before the block's result, so still inside it.
    expect(settleAt).toBeLessThan(locked.indexOf('\n                left\n'));
  });

  it('is withdrawn by the retry worker when it finds the outbox empty', () => {
    const empty = retry.slice(retry.indexOf('OutboxRetry.Run.NOTHING_OWED -> {'));
    expect(empty.slice(0, 600)).toContain(
      'CanariFirebaseMessagingService.settleOutboxNudge(applicationContext, "OutboxRetryWorker")'
    );
  });

  it('withdraws reading the shade once, logging only what stood', () => {
    const withdraw = body(service, 'private fun withdrawOutboxNudge(');
    expect(withdraw.match(/manager\.activeNotifications/g)).toHaveLength(1);
    expect(withdraw).toContain(
      'val stood = try {\n                OutboxNudge.nudgeStood(manager.activeNotifications.map { it.id })'
    );
    // A failed read never costs the withdrawal: it is caught, and the cancel runs after the catch,
    // unconditionally.
    const caught = withdraw.indexOf('} catch (e: Exception) {');
    const cancelAt = withdraw.indexOf('            manager.cancel(OUTBOX_NUDGE_NOTIF_ID)\n');
    expect(caught).toBeGreaterThan(withdraw.indexOf('manager.activeNotifications'));
    expect(cancelAt).toBeGreaterThan(caught);
    // The withdrawal line exists only behind what the shade showed.
    expect(withdraw).toContain(
      'if (stood) Log.d(TAG, "$where: outbox mirror empty - nudge withdrawn (id=$OUTBOX_NUDGE_NOTIF_ID)")'
    );
    expect(service.match(/nudge withdrawn \(id=/g)).toHaveLength(1);
    // The worker's foreground notice is never cancelled by the service: an update already cleared
    // every nudge a pre-1.7.3 build posted under its id (mobile.md, "The outbox nudge").
    expect(service).not.toMatch(/WORKER_FOREGROUND/);
    for (const source of [service, worker, retry]) {
      expect(source).not.toMatch(
        /cancel\((FixedNotifIds\.WORKER_FOREGROUND|FOREGROUND_NOTIF_ID)\)/
      );
    }
    expect(service).toContain(
      'OutboxNudge.Decision.WITHDRAW -> withdrawOutboxNudge(manager, where)'
    );
  });

  it('keeps every fixed id out of the unread badge, through the one table', () => {
    const count = body(service, 'internal fun countUnreadConversations(');
    expect(count).toContain('sbn.id !in FixedNotifIds.ALL &&');
    expect(count).not.toMatch(/sbn\.id != /);
  });
});

import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { handleWelcomeRequest } from '$lib/utils/chat/actions';

/**
 * ONE WAY A `welcome_request` IS SERVED, AND ONE PLACE THAT SAYS WHAT HAPPENS WHEN IT CANNOT BE.
 *
 * A device that has lost its MLS state asks the group's members to re-add it, and the member that
 * answers must already hold a READY conversation for that group - it cannot invite anyone into a
 * group it is still joining itself. So the responder has a third outcome beside "served" and
 * "refused": **not yet**, and the only correct thing to do with it is to remember the asker and
 * serve them the moment the group becomes ready.
 *
 * **THAT IS A POLICY, AND IT WAS WRITTEN AT ONE OF THE TWO ENTRANCES.** The socket entrance passed
 * an `onNotReady` that queued the asker; the queue's own drain passed none - so a request that came
 * back "not yet" a second time fell into a `?.()` on an absent callback, after the queue had already
 * been emptied. The asker's own 60-second retry was the only thing left, and the drop said nothing.
 * The two entrances differ in exactly one thing - WHERE the request came from - and everything else
 * they had in common was written twice.
 *
 * Both entrances call {@link serveWelcomeRequest} now. The deferral, the deduplication and the log
 * live here, once, and the drain is {@link drainDeferredWelcomeRequests}, which re-defers by the
 * same path it drains through: a group that is still not ready keeps its askers.
 */

/** An asker waiting for a group to become ready. Identity is `(userId, deviceId)`, never userId. */
export interface DeferredWelcomeRequest {
  requesterUserId: string;
  requesterDeviceId: string;
}

/** Everything serving a `welcome_request` needs, and nothing a session composable holds besides. */
export interface WelcomeRequestContext {
  mlsService: IMlsService;
  storage: IStorage | null;
  userId: string;
  deviceKeyB64: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
  /** groupId -> the askers waiting for it. Drained by {@link drainDeferredWelcomeRequests}. */
  deferred: Map<string, DeferredWelcomeRequest[]>;
}

/** `true` when this asker is already waiting on `groupId`. */
function alreadyWaiting(list: DeferredWelcomeRequest[], request: DeferredWelcomeRequest): boolean {
  return list.some(
    (q) =>
      q.requesterUserId === request.requesterUserId &&
      q.requesterDeviceId === request.requesterDeviceId
  );
}

/**
 * Serves one `welcome_request`, and queues the asker if this device is not ready to serve it.
 *
 * Never throws: it is driven from a WebSocket message handler and from a group-ready notification,
 * and a rejection in either belongs to no group at all. What it logs on failure ACCUSES, because
 * the asker on the other side is locked out of a group they belong to for as long as this is wrong.
 */
export async function serveWelcomeRequest(
  ctx: WelcomeRequestContext,
  request: DeferredWelcomeRequest,
  groupId: string
): Promise<void> {
  try {
    await handleWelcomeRequest({
      mlsService: ctx.mlsService,
      storage: ctx.storage,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      conversations: ctx.conversations,
      log: ctx.log,
      requesterUserId: request.requesterUserId,
      requesterDeviceId: request.requesterDeviceId,
      groupId,
      onNotReady: (terminalGroupId) => {
        const list = ctx.deferred.get(terminalGroupId) ?? [];
        // ONE ENTRY PER ASKER. A device that has been refused re-asks every 60 seconds, and each
        // ask that lands while the group is still not ready would otherwise add another copy of the
        // same waiter - serving them N times on the drain, which the cooldown then absorbs one by
        // one. The queue records WHO is waiting, and a device waiting twice is one waiter.
        if (!alreadyWaiting(list, request)) {
          list.push(request);
          ctx.deferred.set(terminalGroupId, list);
          ctx.log(`[WELCOME_REQ] ${terminalGroupId.slice(0, 8)}... not ready yet - deferred`);
          return;
        }
        ctx.log(
          `[WELCOME_REQ] ${terminalGroupId.slice(0, 8)}... not ready yet - ` +
            `${request.requesterDeviceId.slice(0, 12)}... is already waiting`
        );
      },
    });
  } catch (e) {
    ctx.log(
      `[WELCOME_REQ] ${groupId.slice(0, 8)}... serving ${request.requesterDeviceId.slice(0, 12)}...` +
        ` FAILED: ${String(e)}`
    );
  }
}

/**
 * Serves every asker that was waiting on `groupId`, now that it is ready.
 *
 * **THE QUEUE IS EMPTIED FIRST AND REFILLED BY THE SAME PATH.** "Ready" here is the MLS group
 * becoming sendable, which is not the same event as this device's conversation row reaching
 * `active` - one fire point sets the row first and one does not, so a drain can still meet a group
 * that {@link handleWelcomeRequest} calls not ready. Serving through {@link serveWelcomeRequest}
 * means such an asker is put back on the queue rather than dropped, and the next ready event
 * finds them.
 */
export async function drainDeferredWelcomeRequests(
  ctx: WelcomeRequestContext,
  groupId: string
): Promise<void> {
  const waiting = ctx.deferred.get(groupId);
  if (!waiting?.length) return;

  ctx.deferred.delete(groupId);
  ctx.log(`[WELCOME_REQ] ${groupId.slice(0, 8)}... ready - serving ${waiting.length} deferred`);
  for (const request of waiting) {
    await serveWelcomeRequest(ctx, request, groupId);
  }
}

/**
 * THE SWEEP'S SNAPSHOT IS TAKEN BEFORE THE SWEEP READS ANYTHING (`processDeviceInvitationsLocally`).
 *
 * A pending-invitation sweep may take away, or replace, only the asks that were on screen when it
 * started (`beginJoinRequestSweep`, `joinRequests.svelte.ts`). Taken after the read instead, an ask
 * announced live WHILE the read ran would count as "on screen before", and the sweep's older read
 * would replace it - so this pins the order at the one call site.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JoinApprovalRequest } from '$lib/utils/chat/actions';

const processPendingInvitations = vi.hoisted(() => vi.fn());

vi.mock('$lib/utils/chat/actions', () => ({
  processPendingInvitations,
  handleHistoryRequest: vi.fn(),
  raiseAnnouncedJoinAsk: vi.fn(),
}));

const { processDeviceInvitationsLocally } = await import('./sessionAuth');
const { pendingJoinRequests, raiseJoinRequest, resetJoinRequests } =
  await import('$lib/utils/chat/joinRequests.svelte');

function ctx() {
  let syncing = false;
  return {
    isSyncing: () => syncing,
    setIsSyncing: (v: boolean) => (syncing = v),
    ensureMls: () => ({}),
    getStorage: () => ({}),
    getUserId: () => 'member',
    getDeviceKey: () => 'key',
  } as never;
}

describe('the pending-invitation sweep and an ask announced while it reads', () => {
  beforeEach(() => {
    resetJoinRequests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('keeps the live ask: the snapshot predates the read', async () => {
    processPendingInvitations.mockImplementation(
      async (deps: { onJoinApprovalRequested: (r: JoinApprovalRequest) => void }) => {
        // The read found the person's OLDER ask; their newer one is announced while it runs.
        raiseJoinRequest({
          groupId: 'g1',
          requesterUserId: 'carol',
          requesterDeviceId: 'c2',
          askId: 'a2',
        });
        deps.onJoinApprovalRequested({
          groupId: 'g1',
          requesterUserId: 'carol',
          requesterDeviceId: 'c1',
          askId: 'a1',
        });
        return true;
      }
    );

    await processDeviceInvitationsLocally(ctx(), {
      log: vi.fn(),
      conversations: new Map(),
    } as never);

    expect(pendingJoinRequests().map((r) => r.askId)).toEqual(['a2']);
  });
});

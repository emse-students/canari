import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerJoinRequest,
  canAnswerJoinRequests,
  pendingJoinRequests,
  raiseJoinRequest,
  resetJoinRequests,
  setJoinRequestHandlers,
  settleSweptJoinRequests,
} from './joinRequests.svelte';

/**
 * A new person is admitted only by a member's gesture: the automatic adders raise an ask here, and a
 * member answers it. One entry per person and conversation; the sweep's `pending` rows are the
 * durable state the entries follow.
 */
const ask = (userId: string, deviceId: string, groupId = 'g1') => ({
  groupId,
  requesterUserId: userId,
  requesterDeviceId: deviceId,
});

beforeEach(() => {
  resetJoinRequests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setJoinRequestHandlers(null);
  vi.restoreAllMocks();
});

describe('joinRequests - one ask per person and conversation', () => {
  it('folds a second device and a repeated ask into one entry', () => {
    raiseJoinRequest(ask('Carol', 'c1'));
    raiseJoinRequest(ask('carol', 'c2'));
    raiseJoinRequest(ask('carol', 'c1'));

    expect(pendingJoinRequests()).toEqual([
      { groupId: 'g1', userId: 'carol', deviceIds: ['c1', 'c2'] },
    ]);
  });

  it('keeps the same person apart in two conversations', () => {
    raiseJoinRequest(ask('carol', 'c1', 'g1'));
    raiseJoinRequest(ask('carol', 'c1', 'g2'));

    expect(pendingJoinRequests().map((r) => r.groupId)).toEqual(['g1', 'g2']);
  });
});

describe('joinRequests - a sweep settles what it no longer raises', () => {
  it('drops an ask the sweep did not raise again, and keeps the others', () => {
    raiseJoinRequest(ask('carol', 'c1'));
    raiseJoinRequest(ask('dave', 'd1'));

    settleSweptJoinRequests([ask('dave', 'd1')]);

    expect(pendingJoinRequests().map((r) => r.userId)).toEqual(['dave']);
  });
});

describe('joinRequests - a member answers', () => {
  it('runs the approval and the ask leaves', async () => {
    const approve = vi.fn(async () => ({ done: true as const }));
    setJoinRequestHandlers({ approve, decline: vi.fn() });
    raiseJoinRequest(ask('carol', 'c1'));
    const [request] = pendingJoinRequests();

    expect(await answerJoinRequest(request, 'approve')).toBe(true);
    expect(approve).toHaveBeenCalledWith(request);
    expect(pendingJoinRequests()).toEqual([]);
  });

  it('keeps the ask when the Add did not happen - no exception is not an Add', async () => {
    // A known outcome, named by its reason: a warning, never an error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setJoinRequestHandlers({
      approve: vi.fn(async () => ({
        done: false as const,
        reason: 'the Add did not happen (add-lock-busy)',
      })),
      decline: vi.fn(),
    });
    raiseJoinRequest(ask('carol', 'c1'));
    const [request] = pendingJoinRequests();

    expect(await answerJoinRequest(request, 'approve')).toBe(false);
    expect(pendingJoinRequests()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('add-lock-busy'));
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the ask when the answer fails, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setJoinRequestHandlers({
      approve: vi.fn(),
      decline: vi.fn(async () => {
        throw new Error('403');
      }),
    });
    raiseJoinRequest(ask('carol', 'c1'));
    const [request] = pendingJoinRequests();

    expect(await answerJoinRequest(request, 'decline')).toBe(false);
    expect(pendingJoinRequests()).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the ask stays'));
  });

  it('runs nothing and keeps the ask when no page registered the answers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    raiseJoinRequest(ask('carol', 'c1'));
    const [request] = pendingJoinRequests();

    expect(await answerJoinRequest(request, 'approve')).toBe(false);
    expect(pendingJoinRequests()).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no handler registered'));
  });

  it('says whether an ask can be answered, so the banner shows one only while it can', () => {
    // Tapped while the chat page was unmounted, the banner's answer failed with a toast.
    expect(canAnswerJoinRequests()).toBe(false);
    setJoinRequestHandlers({ approve: vi.fn(), decline: vi.fn() });
    expect(canAnswerJoinRequests()).toBe(true);
    setJoinRequestHandlers(null);
    expect(canAnswerJoinRequests()).toBe(false);
  });
});

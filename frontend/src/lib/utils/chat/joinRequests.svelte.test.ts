import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerJoinRequest,
  beginJoinRequestSweep,
  canAnswerJoinRequests,
  pendingJoinRequests,
  raiseJoinRequest,
  resetJoinRequests,
  setJoinRequestHandlers,
  settleJoinRequest,
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

    settleSweptJoinRequests(beginJoinRequestSweep(), [ask('dave', 'd1')]);

    expect(pendingJoinRequests().map((r) => r.userId)).toEqual(['dave']);
  });

  it('keeps an ask announced while the sweep was reading - its rows may predate it', () => {
    raiseJoinRequest({ ...ask('carol', 'c1'), askId: 'a-carol' });
    const sweep = beginJoinRequestSweep();
    // Announced live after the sweep started reading the server's rows.
    raiseJoinRequest({ ...ask('dave', 'd1'), askId: 'a-dave' });

    settleSweptJoinRequests(sweep, []);

    expect(pendingJoinRequests().map((r) => r.askId)).toEqual(['a-dave']);
  });

  it("keeps a person's NEWER ask that replaced the one on screen while the sweep read", () => {
    raiseJoinRequest({ ...ask('carol', 'c1'), askId: 'a1' });
    const sweep = beginJoinRequestSweep();
    raiseJoinRequest({ ...ask('carol', 'c2'), askId: 'a2' });

    settleSweptJoinRequests(sweep, []);

    expect(pendingJoinRequests().map((r) => r.askId)).toEqual(['a2']);
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

/**
 * ANY MEMBER MAY ANSWER, SO EVERY MEMBER'S SCREEN SETTLES ON THE SERVER'S OUTCOME
 * (`group.join_ask.settled`) - the member who did not answer, and the one whose answer lost the race
 * (two Adds, or an Add and a Decline the server's seat lock ordered), without a refresh. An ask is
 * settled BY ITS IDENTITY (the seat id the server names), never by the order frames arrive in.
 */
describe('joinRequests - settling on the outcome another member made', () => {
  const withId = (userId: string, deviceId: string, askId: string, groupId = 'g1') => ({
    ...ask(userId, deviceId, groupId),
    askId,
  });

  it("takes the ask off this screen on the server's outcome, whichever member answered", () => {
    raiseJoinRequest(withId('carol', 'c1', 'a-carol'));
    raiseJoinRequest(withId('dave', 'd1', 'a-dave'));

    settleJoinRequest({ groupId: 'g1', userId: 'Carol', askId: 'a-carol', outcome: 'declined' });

    expect(pendingJoinRequests().map((r) => r.userId)).toEqual(['dave']);
  });

  it.each(['admitted', 'declined', 'expired', 'withdrawn'] as const)(
    'settles on a %s outcome',
    (outcome) => {
      raiseJoinRequest(withId('carol', 'c1', 'a1'));

      settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome });

      expect(pendingJoinRequests()).toEqual([]);
    }
  );

  it('never raises a settled ask again - a sweep or a roster read that landed late', () => {
    // The settlement arrived first; a sweep that READ before it lands after it.
    settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'admitted' });

    raiseJoinRequest(withId('carol', 'c1', 'a1'));
    settleSweptJoinRequests(beginJoinRequestSweep(), [withId('carol', 'c1', 'a1')]);

    expect(pendingJoinRequests()).toEqual([]);
  });

  it('raises a new ask of the same person - a new seat is a new identity', () => {
    settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'declined' });

    raiseJoinRequest(withId('carol', 'c1', 'a2'));

    expect(pendingJoinRequests()).toEqual([
      { groupId: 'g1', userId: 'carol', deviceIds: ['c1'], askId: 'a2' },
    ]);
  });

  it("replaces an entry with the person's newer ask, and an old ask's settlement leaves it", () => {
    raiseJoinRequest(withId('carol', 'c1', 'a1'));
    raiseJoinRequest(withId('carol', 'c2', 'a2'));

    settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'withdrawn' });

    expect(pendingJoinRequests()).toEqual([
      { groupId: 'g1', userId: 'carol', deviceIds: ['c2'], askId: 'a2' },
    ]);
  });

  it('runs no answer on an ask the server already settled, and reports nothing failed', async () => {
    const approve = vi.fn(async () => ({ done: true as const }));
    const decline = vi.fn(async () => ({ done: true as const }));
    setJoinRequestHandlers({ approve, decline });
    raiseJoinRequest(withId('carol', 'c1', 'a1'));
    const [request] = pendingJoinRequests();
    settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'declined' });

    // A stale Add (or Decline) tapped on a banner rendered before the settlement.
    expect(await answerJoinRequest(request, 'approve')).toBe(true);
    expect(await answerJoinRequest(request, 'decline')).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
  });

  it('reports an answer the server settled WHILE it ran as nothing left, not a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setJoinRequestHandlers({
      approve: vi.fn(async () => {
        settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'declined' });
        return { done: false as const, reason: 'invitation-withdrawn' };
      }),
      decline: vi.fn(),
    });
    raiseJoinRequest(withId('carol', 'c1', 'a1'));
    const [request] = pendingJoinRequests();

    expect(await answerJoinRequest(request, 'approve')).toBe(true);
    expect(pendingJoinRequests()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not remove the person's newer ask when an answer to the older one goes through", async () => {
    setJoinRequestHandlers({
      approve: vi.fn(async () => {
        raiseJoinRequest(withId('carol', 'c2', 'a2'));
        return { done: true as const };
      }),
      decline: vi.fn(),
    });
    raiseJoinRequest(withId('carol', 'c1', 'a1'));
    const [request] = pendingJoinRequests();

    expect(await answerJoinRequest(request, 'approve')).toBe(true);
    expect(pendingJoinRequests().map((r) => r.askId)).toEqual(['a2']);
  });

  it('forgets the settlements with the asks at sign-out', () => {
    settleJoinRequest({ groupId: 'g1', userId: 'carol', askId: 'a1', outcome: 'declined' });
    resetJoinRequests();

    raiseJoinRequest(withId('carol', 'c1', 'a1'));
    expect(pendingJoinRequests()).toHaveLength(1);
  });
});

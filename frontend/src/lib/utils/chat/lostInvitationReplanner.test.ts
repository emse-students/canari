import { makeLostInvitationReplanner } from './lostInvitationReplanner';
import type { OwedInvitation } from '$lib/mls-client/owedInvitations';
import type { Conversation } from '$lib/types';

/**
 * THE RE-PLANNER'S VERDICT IS WHAT HAPPENS TO THE ENTRY, so no ending is silent: a conversation that
 * is not usable YET keeps it for the event that makes it usable, a retired one is told, and only an
 * active one is re-planned.
 */
const G = 'g1';
const owed: OwedInvitation = {
  groupId: G,
  baseEpoch: 2,
  invitation: { users: ['w5'], rostered: [] },
  cause: 'race',
  reason: 'epoch_mismatch',
};

function harness(rows: Array<[string, Partial<Conversation>]>, heldGroups: string[] = [G]) {
  const conversations = new Map(
    rows.map(([key, row]) => [key, { id: G, name: 'Club', lifecycle: 'active', ...row }])
  ) as unknown as Map<string, Conversation>;
  const deps = {
    conversations,
    mlsService: { getLocalGroups: () => heldGroups },
    replan: vi.fn(async () => ({ kind: 'completed' }) as const),
    report: vi.fn(),
    afterCompleted: vi.fn(async () => {}),
    isCurrent: vi.fn(() => true),
  };
  return { deps, replanner: makeLostInvitationReplanner(deps as never), conversations };
}

describe('makeLostInvitationReplanner - what a lost invitation waits for, and who is told', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a PENDING conversation keeps the entry, and re-plans it once the conversation is active', async () => {
    const h = harness([[G, { lifecycle: 'pending' }]]);
    expect(await h.replanner(owed)).toBe('waiting');
    expect(h.deps.replan).not.toHaveBeenCalled();
    expect(h.deps.report).not.toHaveBeenCalled();

    // Its Welcome was processed: the same entry, drained again, is re-planned.
    (h.conversations.get(G) as Conversation).lifecycle = 'active';
    expect(await h.replanner(owed)).toBe('concluded');
    expect(h.deps.replan).toHaveBeenCalledTimes(1);
    expect(h.deps.afterCompleted).toHaveBeenCalledTimes(1);
  });

  it('no row yet while the group is held: WAITING for the row to be available', async () => {
    const h = harness([]);
    expect(await h.replanner(owed)).toBe('waiting');
    expect(h.deps.report).not.toHaveBeenCalled();
  });

  it('neither a row nor the group (left on this device): concluded, nothing to re-plan into', async () => {
    const h = harness([], []);
    expect(await h.replanner(owed)).toBe('concluded');
    expect(h.deps.replan).not.toHaveBeenCalled();
  });

  it('a RETIRED conversation is told as gone - never dropped silently', async () => {
    const h = harness([[G, { lifecycle: 'removed' }]]);
    expect(await h.replanner(owed)).toBe('concluded');
    expect(h.deps.report).toHaveBeenCalledExactlyOnceWith({ kind: 'conversation-gone' }, 'Club');
  });

  it('a legacy direct row keyed otherwise is found by its group', async () => {
    const h = harness([['w1::w5', {}]]);
    expect(await h.replanner(owed)).toBe('concluded');
    expect(h.deps.replan).toHaveBeenCalledTimes(1);
  });

  it("another device's add lock is WAITING: no word to the member, the entry stays", async () => {
    const h = harness([[G, {}]]);
    h.deps.replan.mockResolvedValueOnce({ kind: 'waiting', on: 'add-lock' } as never);
    expect(await h.replanner(owed)).toBe('waiting');
    expect(h.deps.report).not.toHaveBeenCalled();
  });

  it('a session that ENDED during the re-plan tells nothing and keeps the entry for its account', async () => {
    const h = harness([[G, {}]]);
    h.deps.replan.mockImplementationOnce(async () => {
      h.deps.isCurrent.mockReturnValue(false);
      return { kind: 'refused', reason: 'committer_not_member' } as never;
    });
    expect(await h.replanner(owed)).toBe('waiting');
    expect(h.deps.report).not.toHaveBeenCalled();
  });

  it('a re-plan that throws is told as a failure and concluded', async () => {
    const h = harness([[G, {}]]);
    h.deps.replan.mockRejectedValueOnce(new Error('boom'));
    expect(await h.replanner(owed)).toBe('concluded');
    expect(h.deps.report).toHaveBeenCalledExactlyOnceWith(
      { kind: 'not-completed', reason: 'failed' },
      'Club'
    );
  });
});

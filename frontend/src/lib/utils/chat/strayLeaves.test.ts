import type { IMlsService } from '$lib/mls-client/IMlsService';
import { removeStrayLeaves } from './strayLeaves';

/**
 * A leaver's leaf outlives the leaver, and only a remaining member can collect it.
 *
 * `leaveGroupAndBroadcast` stages no Remove for its own leaf and cannot - a departing member is
 * exactly the party that may not commit its own eviction. These pin the diff that finally does it
 * for a CONVERSATION, and, just as important, every case in which it must NOT remove anybody.
 */

let getGroupMemberIdentities: ReturnType<typeof vi.fn>;
let getGroupUserMembers: ReturnType<typeof vi.fn>;
let removeMember: ReturnType<typeof vi.fn>;
let getLocalGroups: ReturnType<typeof vi.fn>;
let lines: string[];

const log = (m: string) => lines.push(m);

const mls = () =>
  ({
    getGroupMemberIdentities,
    getGroupUserMembers,
    removeMember,
    getLocalGroups,
    getEpoch: () => 12,
  }) as unknown as IMlsService;

beforeEach(() => {
  lines = [];
  getGroupMemberIdentities = vi.fn().mockResolvedValue(['alice:web-1', 'bob:web-1']);
  getGroupUserMembers = vi.fn().mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
  removeMember = vi.fn().mockResolvedValue(undefined);
  getLocalGroups = vi.fn().mockReturnValue(['g1']);
});

describe('removeStrayLeaves', () => {
  it('removes the leaf of a member the roster no longer names', async () => {
    getGroupMemberIdentities.mockResolvedValue(['alice:web-1', 'bob:web-1', 'bob:android-9']);
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }]);

    const removed = await removeStrayLeaves(mls(), 'g1', 'alice', log);

    expect(removed).toEqual(['bob']);
    // ONE commit covers every device of every stray, so a departure costs one epoch whatever the
    // fleet behind it - both of bob's leaves go in the same breath.
    expect(removeMember).toHaveBeenCalledExactlyOnceWith('g1', ['bob']);
    expect(lines.join(' | ')).toContain('1 member(s) left but still hold a leaf');
  });

  it('commits nothing when the tree already agrees with the roster', async () => {
    const removed = await removeStrayLeaves(mls(), 'g1', 'alice', log);

    expect(removed).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('removes nobody when this device does not hold the tree', async () => {
    // Only a member may commit. This runs inside a loop over every group the SERVER lists, most of
    // which this device does not hold, so it must be cheap and silent rather than an error.
    getLocalGroups.mockReturnValue([]);

    expect(await removeStrayLeaves(mls(), 'g1', 'alice', log)).toEqual([]);
    expect(getGroupUserMembers).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('removes nobody when the roster could not be read', async () => {
    // A fetch that threw is not an empty conversation, and treating it as one would empty the tree
    // of everybody but this device. Absence is a reason to ask again later, never to destroy.
    getGroupUserMembers.mockRejectedValue(new Error('502'));

    expect(await removeStrayLeaves(mls(), 'g1', 'alice', log)).toEqual([]);
    expect(removeMember).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('could not compare the tree with its roster');
  });

  it('never removes this device, whatever the roster says', async () => {
    // A device that removed its own leaf would leave the conversation it is holding open, with no
    // way back in but a fresh external join. A roster that answered for another group, or a
    // membership row mid-write, must not be able to cause that.
    getGroupUserMembers.mockResolvedValue([]);

    expect(await removeStrayLeaves(mls(), 'g1', 'alice', log)).toEqual(['bob']);
    expect(removeMember).toHaveBeenCalledExactlyOnceWith('g1', ['bob']);
  });

  it('reports a refused commit rather than claiming the leaves are gone', async () => {
    // Until the commit lands, everyone named still holds key material for the conversation. A
    // rejected commit is the benign case and the next connection carries it - but it is never
    // reported as a removal that happened.
    getGroupUserMembers.mockResolvedValue([{ userId: 'alice' }]);
    removeMember.mockRejectedValue(new Error('epoch_mismatch'));

    expect(await removeStrayLeaves(mls(), 'g1', 'alice', log)).toEqual([]);
    expect(lines.join(' | ')).toContain('their leaves stay');
  });
});

/**
 * A DESTRUCTIVE WRITE HAPPENS AFTER ITS PREREQUISITE IS KNOWN TO HOLD, OR IT LOSES THE RACE FOR IT.
 *
 * `kickStaleLeaf` does two things to two different estates: it removes the stale leaf from the MLS
 * TREE, which decides who can read the group, and it clears the device's ROUTING ROW to `pending`,
 * which decides who the delivery service ships to. Until 2026-09-04 both ran unconditionally, so a
 * refused Remove still wrote `pending`.
 *
 * THAT BECAME LOAD-BEARING THE DAY THE OTHER HALF OF THE SAME P1 WAS FIXED. `pending` used to mean
 * "wait for a member to Add you", and a wrong one cost a delay. It now means, when no Welcome is
 * queued and no add lock is held, "stop waiting and join by external commit" - which is what ended a
 * livelock that ran for twenty hours on production. So clearing the routing row over a leaf that is
 * STILL IN THE TREE asks that device to add a second leaf beside the first, and that is the
 * duplicate-leaf race of 2026-08-26 (GRP-4) reached from the other side: the repair manufacturing
 * the fault it exists to clean up.
 *
 * The three cases below are the whole contract, and the third is the one that has to be a TYPE:
 * "the leaf was never there" and "the Remove was refused" are opposite states of the tree, they used
 * to be one `OpenMls("No member found for identities: ...")` string, and only the first may be read
 * as success.
 */
import { kickStaleLeaf } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

const G = 'group-1';
const USER = 'u-target';
const DEVICE = 'web-u-target-stale';
const IDENTITY = `${USER}:${DEVICE}`;

/** Collects the log so a case can assert on WHAT was reported, not merely that something was. */
const withLog = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};

describe('kickStaleLeaf - the routing row follows the tree, never the other way round', () => {
  it('clears the routing row when the leaf really was removed', async () => {
    const mlsService = createMlsServiceStub({
      removeMemberDevice: vi.fn().mockResolvedValue(undefined),
      kickStaleDevice: vi.fn().mockResolvedValue(undefined),
    });
    const { lines, log } = withLog();

    await kickStaleLeaf(G, USER, DEVICE, mlsService, log);

    expect(mlsService.kickStaleDevice).toHaveBeenCalledWith(DEVICE, USER, G);
    expect(lines.join('\n')).toContain(`Stale leaf ${IDENTITY} removed`);
  });

  it('clears it when the leaf was ALREADY ABSENT - that is the outcome asked for, not a failure', async () => {
    // `MlsError::NoSuchMember` crosses the WASM boundary as the token this repository defines. A
    // tree that never held the leaf is exactly the state the caller wants, so the row may be
    // cleared and the device may go and join itself.
    const mlsService = createMlsServiceStub({
      removeMemberDevice: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'NO_SUCH_MEMBER: no leaf carries any of the identities ["u-target:web-u-target-stale"]'
          )
        ),
      kickStaleDevice: vi.fn().mockResolvedValue(undefined),
    });
    const { lines, log } = withLog();

    await kickStaleLeaf(G, USER, DEVICE, mlsService, log);

    expect(mlsService.kickStaleDevice).toHaveBeenCalledWith(DEVICE, USER, G);
    expect(lines.join('\n')).toContain('was already absent');
    expect(lines.join('\n')).toContain(`Stale leaf ${IDENTITY} removed`);
  });

  it('LEAVES THE ROUTING ROW ALONE when the Remove was refused and the leaf is still in the tree', async () => {
    // THE DEFECT, AS ONE CASE. Writing `pending` here is what would invite a second leaf.
    const mlsService = createMlsServiceStub({
      removeMemberDevice: vi
        .fn()
        .mockRejectedValue(new Error('RemoveMembers error: EpochMismatch')),
      kickStaleDevice: vi.fn().mockResolvedValue(undefined),
    });
    const { lines, log } = withLog();

    await kickStaleLeaf(G, USER, DEVICE, mlsService, log);

    expect(mlsService.kickStaleDevice).not.toHaveBeenCalled();
    const out = lines.join('\n');
    expect(out).toContain('still in');
    expect(out).toContain('left ALONE on purpose');
    // AND IT SAYS SO IN THE SUMMARY LINE TOO. A reader following one line must not be told the leaf
    // was removed - the silence around this pair is what cost a night in the first place.
    expect(out).toContain('PARTIALLY removed');
    expect(out).toContain('tree=still present');
    expect(out).toContain('routing=still listed');
  });

  it('never throws, whichever half failed - both callers fall through deliberately', async () => {
    const mlsService = createMlsServiceStub({
      removeMemberDevice: vi.fn().mockRejectedValue(new Error('RemoveMembers error: whatever')),
      kickStaleDevice: vi.fn().mockRejectedValue(new Error('500')),
    });

    await expect(kickStaleLeaf(G, USER, DEVICE, mlsService, () => {})).resolves.toBeUndefined();
  });

  it('reports the routing failure on its own when the tree WAS cleared', async () => {
    // The two halves are independent estates and fail independently; one line saying "partially"
    // without naming which half would leave the reader where the silence did.
    const mlsService = createMlsServiceStub({
      removeMemberDevice: vi.fn().mockResolvedValue(undefined),
      kickStaleDevice: vi.fn().mockRejectedValue(new Error('503')),
    });
    const { lines, log } = withLog();

    await kickStaleLeaf(G, USER, DEVICE, mlsService, log);

    const out = lines.join('\n');
    expect(out).toContain('still listed');
    expect(out).toContain('tree=cleared');
    expect(out).toContain('routing=still listed');
  });
});

/**
 * A DOCUMENT THAT NO LONGER OWNS THE MLS STATE ACKNOWLEDGES NOTHING (the hand-over of #3321 with
 * #3371's single writer).
 *
 * The lead now moves while the old leader goes on running: a hidden leader hands it to a visible
 * tab, Chromium freezes it and resumes it later, a promotion reload steals it (`tabLeader.ts`). A
 * drain that was running in the old leader ends after that, and its acknowledgement used to leave
 * as usual - but what that drain decrypted is in no checkpoint (`persistCheckpoint` refuses on the
 * same fact, and the latch at the put refuses a write already sealing), while the tab that leads now
 * loaded the state on disk. The ack deleted from the server the one copy of a frame that state still
 * needed. Withheld, the frame stays queued and the leader's pull reads it on the written state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const role = vi.hoisted(() => ({ now: 'leader' as 'leader' | 'follower' | 'undecided' }));
vi.mock('$lib/mls-client/tabLeader', () => ({
  getTabLeadership: () => role.now,
  leaderLockReleasedForUnload: () => false,
}));

import { BaseMlsService } from '$lib/services/BaseMlsService';
import { noteMlsStateLoaded, resetStateAuthorityForTests } from '$lib/mls-client/stateAuthority';

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    announceAck(messageIds: string[]): Promise<void>;
    unacknowledged: Set<string>;
  };

describe('an ack asked after the lead left this document', () => {
  let svc: BaseMlsService;
  let ackMessages: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    role.now = 'leader';
    resetStateAuthorityForTests();
    // The login loaded the state as the leader.
    noteMlsStateLoaded(true);
    svc = makeService();
    ackMessages = vi.fn(async () => {});
    Object.assign(svc, { userId: 'user-a', delivery: { ackMessages } });
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a leader acknowledges', async () => {
    await inner(svc).announceAck(['row-1']);
    expect(ackMessages).toHaveBeenCalledExactlyOnceWith(['row-1']);
  });

  it('is withheld once the lead left, even when it was asked while leading - the rows stay for the leader', async () => {
    // A first ack in flight, so the second is decided only when it reaches the front - the step
    // the lead can leave across.
    let land!: () => void;
    ackMessages.mockImplementationOnce(() => new Promise<void>((r) => (land = r)));
    const first = inner(svc).announceAck(['row-1']);
    const second = inner(svc).announceAck(['row-2', 'row-3']);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The first left while this document led; the second waits behind it.
    expect(ackMessages).toHaveBeenCalledTimes(1);

    // The hidden leader hands the lead over: `follower` is decided before the lock moves.
    role.now = 'follower';
    land();
    await first;
    await second;

    expect(ackMessages).toHaveBeenCalledExactlyOnceWith(['row-1']);
    expect([...inner(svc).unacknowledged]).toEqual(['row-2', 'row-3']);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('2 id(s) not acknowledged: this tab no longer owns the MLS state')
    );
  });

  it('a leader promoted in place, its reload owed, does not acknowledge either - its copy is not the written one', async () => {
    resetStateAuthorityForTests();
    noteMlsStateLoaded(false);
    role.now = 'leader';
    await inner(svc).announceAck(['row-1']);
    expect(ackMessages).not.toHaveBeenCalled();
  });

  it('the empty flush is withheld silently - it names no row', async () => {
    role.now = 'follower';
    await inner(svc).announceAck([]);
    expect(ackMessages).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

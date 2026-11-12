/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { OneTimeKeyPackage } from '../entities/one-time-key-package.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { PushToken } from '../entities/push-token.entity';
import { MlsCommitLog } from '../entities/mls-commit-log.entity';
import { MlsGroupInfo } from '../entities/mls-group-info.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { stubQueryBuilder } from '../testing/queryBuilder';

/**
 * A HISTORY WALK IS BOUNDED BY THE STREAM HEAD IT WAS GIVEN AT ITS START.
 *
 * The archive holds every frame, including the ones still queued for live delivery. A walk whose
 * upper bound is `+` therefore reads whatever was appended while it was walking - precisely the rows
 * the delivery queue is about to hand over - and both paths then present the same ciphertext to MLS.
 * On a large conversation that overlap lasts as long as the walk does.
 *
 * The head pins it: at or below belongs to the replay, above belongs to the queue, and the rows
 * above are never read at all - no bytes, no decrypt, no ledger entry. These cases hold the two
 * halves that make it true on the server: the bound is honoured as the XRANGE end, and the head is
 * read exactly once per walk rather than on every page.
 */
describe('MessagingService history - the walk is bounded by the head', () => {
  let service: MessagingService;
  let redis: {
    xrange: jest.Mock;
    xrevrange: jest.Mock;
    del: jest.Mock;
  };
  /** Held so a case can say which groups exist - the orphan purge answers first when they do not. */
  let groupRepo: ReturnType<typeof emptyRepo> & { find: jest.Mock; manager: { find: jest.Mock } };

  const GROUP = 'group-1';
  /** History is a member's read: the caller holds an admitted seat in every group it asks for. */
  const MEMBER = 'member-1';

  /**
   * One stream entry. No `sender_id`: display-name enrichment is out of scope here and returns
   * early when a page names no sender, which keeps these cases to the one thing they assert.
   */
  const entry = (id: string): [string, string[]] => [id, ['content', 'ciphertext']];

  const emptyRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: unknown) => e),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn().mockImplementation((e: unknown) => e),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    redis = {
      xrange: jest.fn().mockResolvedValue([]),
      xrevrange: jest.fn().mockResolvedValue([]),
      del: jest.fn(),
    };

    groupRepo = {
      ...emptyRepo(),
      // The group must exist, or the orphan purge answers before anything reads the stream.
      find: jest.fn().mockResolvedValue([{ id: GROUP }]),
      // The member's interval, open since the epoch: nothing withheld, which is not the subject here.
      manager: {
        find: jest
          .fn()
          .mockResolvedValue([{ groupId: GROUP, joinedAt: new Date(0), leftAt: null }]),
      },
    };
    // `IN (...)` honoured, as Postgres would: one admitted seat per group asked about.
    const seats = {
      ...emptyRepo(),
      find: jest
        .fn()
        .mockImplementation(async (opts: { where: { groupId: { value: string[] } } }) =>
          opts.where.groupId.value.map((groupId) => ({ groupId, awaitingAdmission: false }))
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: seats },
        { provide: getRepositoryToken(Group), useValue: groupRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(OneTimeKeyPackage), useValue: emptyRepo() },
        {
          provide: getRepositoryToken(DeviceGroupMembership),
          // The reader's earliest device row per group, read once per request: none here.
          useValue: { ...emptyRepo(), createQueryBuilder: () => stubQueryBuilder() },
        },
        { provide: getRepositoryToken(PushToken), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsCommitLog), useValue: emptyRepo() },
        { provide: getRepositoryToken(MlsGroupInfo), useValue: emptyRepo() },
        { provide: getRepositoryToken(RevokedDevice), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(MessagingService);
  });

  /** The XRANGE the service issued: `[key, start, end, 'COUNT', limit]`. */
  const rangeCall = () => redis.xrange.mock.calls[0];

  it('reports the stream head so the caller can pin the rest of its walk', async () => {
    redis.xrevrange.mockResolvedValue([entry('99-0')]);

    const { head } = await service.getHistory(GROUP, undefined, MEMBER);

    expect(head).toBe('99-0');
    expect(rangeCall()[2]).toBe('+');
  });

  it('honours the bound as the XRANGE end, so rows above it are never read', async () => {
    await service.getHistory(GROUP, '3-0', MEMBER, undefined, '42-0');

    // Exclusive lower bound, INCLUSIVE upper bound - the head row is part of the walk.
    expect(rangeCall()[1]).toBe('(3-0');
    expect(rangeCall()[2]).toBe('42-0');
  });

  it('reads the head only when the caller has none, so a walk pays for it once', async () => {
    await service.getHistory(GROUP, '3-0', MEMBER, undefined, '42-0');

    expect(redis.xrevrange).not.toHaveBeenCalled();
  });

  it('echoes the bound back, so a paging caller never has to remember it twice', async () => {
    const { head } = await service.getHistory(GROUP, '3-0', MEMBER, undefined, '42-0');

    expect(head).toBe('42-0');
  });

  it('has no head to report on an empty stream, and that is not an error', async () => {
    redis.xrevrange.mockResolvedValue([]);

    const { rows, head } = await service.getHistory(GROUP, undefined, MEMBER);

    expect(head).toBeUndefined();
    expect(rows).toEqual([]);
  });

  /**
   * A cursor that is not a stream id is a client that has lost its place. Dropping it gives the
   * unbounded read it would have had with no cursor at all - the honest answer - where passing it
   * through would make Redis reject a request the caller cannot act on.
   */
  it('drops a malformed bound rather than failing the read', async () => {
    await service.getHistory(GROUP, undefined, MEMBER, undefined, 'not-a-stream-id');

    expect(rangeCall()[2]).toBe('+');
  });

  it('drops a malformed cursor the same way', async () => {
    await service.getHistory(GROUP, '"; FLUSHALL --', MEMBER);

    expect(rangeCall()[1]).toBe('-');
  });

  it('gives the batch caller one head per group, keyed like the histories', async () => {
    redis.xrevrange.mockResolvedValue([entry('7-0')]);

    const { histories, heads } = await service.getHistoryBatch([{ groupId: GROUP }], MEMBER);

    expect(histories[GROUP]).toEqual([]);
    expect(heads[GROUP]).toBe('7-0');
  });

  /**
   * THE CAP IS A CONTRACT, AND THE CLIENT HOLDS THE OTHER HALF OF IT.
   *
   * `HISTORY_BATCH_MAX_GROUPS` in `frontend/src/lib/mls-client/mlsDeliveryApi.ts` is the size the
   * client chunks at, and nothing on the wire tells it what that size should be. These two cases
   * pin the number here so lowering it is a deliberate act that breaks a test naming the file that
   * has to change with it - the client learning the cap by being REFUSED is what this cost once:
   * one 400 and one request per conversation, for every client past fifty of them.
   */
  it('accepts a batch of exactly the size the client chunks at', async () => {
    const groups = Array.from({ length: 50 }, (_, i) => ({ groupId: `g${i}` }));
    groupRepo.find.mockResolvedValue(groups.map((g) => ({ id: g.groupId })));

    const { histories } = await service.getHistoryBatch(groups, MEMBER);

    expect(Object.keys(histories)).toHaveLength(50);
  });

  it('refuses one more than that, and says how many it takes', async () => {
    const groups = Array.from({ length: 51 }, (_, i) => ({ groupId: `g${i}` }));

    await expect(service.getHistoryBatch(groups, MEMBER)).rejects.toThrow(
      'At most 50 groups per batch'
    );
  });
});

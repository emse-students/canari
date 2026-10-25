/// <reference types="jest" />

import type { EntityManager } from 'typeorm';
import {
  endDeviceMemberships,
  endGroupMembership,
  ensureGroupMember,
  exclusionWindows,
  openMissingIntervals,
  withheldWindows,
  withholdExcludedHistoryRows,
} from './group-membership';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { recordingDataSource } from '../testing/recordingDataSource';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';

/**
 * The statement this helper builds is the whole of what it does, so the statement is what is
 * asserted: an INSERT that says nothing on conflict, and member values that never name `joinedAt`.
 *
 * Both halves matter for the same reason. `ON CONFLICT DO UPDATE SET "joinedAt"` is how a
 * production group ended up with no row carrying its own creation minute, and passing `joinedAt`
 * explicitly is how the column stopped being written by the `@CreateDateColumn` that defines it.
 * Neither would fail a behavioural test - nothing reads the column - which is precisely why the
 * shape is pinned here.
 */
describe('ensureGroupMember', () => {
  type Insert = { calls: string[]; values: Record<string, unknown> | undefined; target: unknown };

  /**
   * Records every INSERT the helper builds, one entry per `insert()`. `firstDeviceAt` is what the
   * person's earliest device row in the group says, read before the interval is opened.
   */
  function managerWithRecorder(
    firstDeviceAt: Date | Date[] | null = null,
    lastLeftAt: Date | null = null
  ): {
    manager: EntityManager;
    inserts: Insert[];
    deviceReads: unknown[];
  } {
    const inserts: Insert[] = [];
    const current = () => inserts[inserts.length - 1];
    const builder: Record<string, unknown> = {};
    const step = (name: string, capture?: (arg: unknown) => void) => (arg?: unknown) => {
      current().calls.push(name);
      capture?.(arg);
      return builder;
    };
    builder.insert = () => {
      inserts.push({ calls: ['insert'], values: undefined, target: undefined });
      return builder;
    };
    builder.into = step('into', (arg) => {
      current().target = arg;
    });
    builder.values = step('values', (arg) => {
      current().values = arg as Record<string, unknown>;
    });
    builder.orIgnore = step('orIgnore');
    builder.orUpdate = step('orUpdate');
    builder.returning = step('returning');
    builder.execute = () => {
      current().calls.push('execute');
      return Promise.resolve({ affected: 1 });
    };

    const deviceReads: unknown[] = [];
    // A small table: the person's device rows and closed intervals in the group. The device read
    // honours the `lastLeftAt` bound it is given, as the SQL does.
    const rows = Array.isArray(firstDeviceAt)
      ? firstDeviceAt
      : firstDeviceAt
        ? [firstDeviceAt]
        : [];
    const manager = {
      createQueryBuilder: () => builder,
      getRepository: (entity: unknown) => {
        deviceReads.push(entity);
        let bound: Date | null = null;
        const qb: Record<string, unknown> = {};
        qb.select = () => qb;
        qb.where = () => qb;
        qb.andWhere = (_sql: string, params?: { lastLeftAt?: Date }) => {
          if (params?.lastLeftAt) bound = params.lastLeftAt;
          return qb;
        };
        qb.getRawOne = () => {
          if (entity === GroupMembershipInterval) return Promise.resolve({ lastLeftAt });
          const kept = rows.filter((r) => bound === null || r.getTime() > bound.getTime());
          const min = kept.length > 0 ? new Date(Math.min(...kept.map((r) => r.getTime()))) : null;
          return Promise.resolve({ firstDeviceAt: min });
        };
        return { createQueryBuilder: () => qb };
      },
    } as unknown as EntityManager;
    return { manager, inserts, deviceReads };
  }

  it('inserts into dm_group_members and says nothing on conflict', async () => {
    const { manager, inserts } = managerWithRecorder();

    await ensureGroupMember(manager, 'g-1', 'alice');

    const member = inserts.find((i) => i.target === GroupMember);
    expect(member?.calls).toContain('orIgnore');
    expect(member?.calls).not.toContain('orUpdate');
    expect(member?.calls[member.calls.length - 1]).toBe('execute');
  });

  it('never writes the MEMBER row joinedAt itself - the column belongs to the insert that created the row', async () => {
    const { manager, inserts } = managerWithRecorder();

    await ensureGroupMember(manager, 'g-1', 'alice');

    expect(inserts.find((i) => i.target === GroupMember)?.values).toEqual({
      groupId: 'g-1',
      userId: 'alice',
      role: 'member',
      // Only an invitation link's acceptance writes a seat that awaits a member's admission.
      awaitingAdmission: false,
    });
  });

  it("writes an invitation link's seat as awaiting a member's admission", async () => {
    const { manager, inserts } = managerWithRecorder();

    await ensureGroupMember(manager, 'g-1', 'alice', { awaitingAdmission: true });

    expect(inserts.find((i) => i.target === GroupMember)?.values).toMatchObject({
      awaitingAdmission: true,
    });
  });

  it('opens an OPEN membership interval, and a second enrolment is a no-op on it too', async () => {
    const { manager, inserts } = managerWithRecorder();
    const before = Date.now();

    await ensureGroupMember(manager, 'g-1', 'alice');

    const interval = inserts.find((i) => i.target === GroupMembershipInterval);
    const { joinedAt, ...rest } = interval?.values ?? {};
    // No device row precedes the enrolment, so nothing earlier than `joinedAt` is recorded.
    expect(rest).toEqual({ groupId: 'g-1', userId: 'alice', leftAt: null, admittedAt: null });
    // The same clock as the message's `createdAt` - this process's - so a window and the
    // messages it is compared with are placed by ONE clock.
    expect(joinedAt).toBeInstanceOf(Date);
    expect((joinedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    // The partial unique index refuses a second open interval; the insert must ignore that refusal
    // exactly as the membership row ignores its own conflict.
    expect(interval?.calls).toContain('orIgnore');
    expect(interval?.calls).not.toContain('orUpdate');
  });

  // THE ARRIVAL SURVIVES A REVOKED DEVICE (review of #2226). An invitee's admitted device row can
  // precede their enrolment by days, and it was the ONLY record of when they arrived: revoking that
  // device deleted it, and their next device lost the span. The interval now keeps it.
  it('records an EARLIER device row on the interval it opens, so a purge of that row cannot move the arrival', async () => {
    const admitted = new Date('2026-10-01T04:00:00Z');
    const { manager, inserts, deviceReads } = managerWithRecorder(admitted);

    await ensureGroupMember(manager, 'g-1', 'alice');

    expect(deviceReads).toEqual([GroupMembershipInterval, DeviceGroupMembership]);
    const interval = inserts.find((i) => i.target === GroupMembershipInterval);
    expect(interval?.values?.admittedAt).toEqual(admitted);
  });

  // A removal deletes the device rows, then closes the interval in another transaction; a
  // registerDevice in between can leave a pending row of the PREVIOUS membership (review of #2254).
  it('ignores a stale device row older than the last departure - it belongs to the previous stretch', async () => {
    const stale = new Date('2026-10-02T23:59:59Z');
    const leftAt = new Date('2026-10-03T00:00:00Z');
    const readmitted = new Date('2026-10-05T00:00:00Z');

    const alone = managerWithRecorder([stale], leftAt);
    await ensureGroupMember(alone.manager, 'g-1', 'alice');
    expect(
      alone.inserts.find((i) => i.target === GroupMembershipInterval)?.values?.admittedAt
    ).toBe(null);

    const withNew = managerWithRecorder([stale, readmitted], leftAt);
    await ensureGroupMember(withNew.manager, 'g-1', 'alice');
    expect(
      withNew.inserts.find((i) => i.target === GroupMembershipInterval)?.values?.admittedAt
    ).toEqual(readmitted);
  });

  it('records nothing when the earliest device row is not earlier than the enrolment', async () => {
    const { manager, inserts } = managerWithRecorder(new Date(Date.now() + 60_000));

    await ensureGroupMember(manager, 'g-1', 'alice');

    expect(inserts.find((i) => i.target === GroupMembershipInterval)?.values?.admittedAt).toBe(
      null
    );
  });
});

describe('endGroupMembership', () => {
  it('deletes the live row AND closes the open interval at the clock that dates messages', async () => {
    const before = Date.now();
    const deletes: Array<{ entity: unknown; where: unknown }> = [];
    const updates: Array<{ entity: unknown; where: Record<string, unknown>; set: unknown }> = [];
    const manager = {
      // The generation the removal's caller just moved the group to, under the seat lock.
      query: async () => [{ seatGeneration: '4' }],
      getRepository: (entity: unknown) => ({
        delete: (where: unknown) => {
          deletes.push({ entity, where });
          return Promise.resolve({ affected: 1 });
        },
        update: (where: Record<string, unknown>, set: unknown) => {
          updates.push({ entity, where, set });
          return Promise.resolve({ affected: 1 });
        },
      }),
    } as unknown as EntityManager;

    const ended = await endGroupMembership(manager, 'g-1', 'bob');

    expect(ended).toEqual({ deleted: 1, closed: 1 });
    expect(deletes).toEqual([{ entity: GroupMember, where: { groupId: 'g-1', userId: 'bob' } }]);
    expect(updates).toHaveLength(1);
    expect(updates[0].entity).toBe(GroupMembershipInterval);
    expect(updates[0].where.groupId).toBe('g-1');
    expect(updates[0].where.userId).toBe('bob');
    // Only the OPEN interval is closed; a closed one keeps the instant it was closed at.
    expect(updates[0].where.leftAt).toBeDefined();
    // This process's clock - the one `queued_message.createdAt` is written with - never a client's.
    const set = updates[0].set as { leftAt: Date; leftAtSeatGeneration: number | null };
    expect(set.leftAt).toBeInstanceOf(Date);
    expect(set.leftAt.getTime()).toBeGreaterThanOrEqual(before);
    // ...and the seat generation it closed at: the counter a stale Add is ordered by, never a clock.
    expect(set.leftAtSeatGeneration).toBe(4);
  });
});

/**
 * A ROSTER MEMBER WITH NO OPEN INTERVAL IS REPAIRED UNDER A LOCK (final review of #1878).
 *
 * The fake below keeps Postgres's one rule that matters here: a row read `FOR SHARE` makes a DELETE
 * of that row wait until the reading transaction ends. Everything else is a table in memory, and the
 * removal is the real `endGroupMembership`.
 */
describe('openMissingIntervals', () => {
  const G = 'g-1';
  const ARRIVED = new Date('2026-10-05T00:00:00Z');
  let roster: Map<string, Date>;
  let intervals: Array<{ userId: string; joinedAt: Date; leftAt: Date | null }>;
  let shareLocks: Map<string, Promise<void>>;
  let insertGate: Promise<void>;

  const manager = () =>
    ({
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const releases: Array<() => void> = [];
        const tx = {
          getRepository: () => ({
            createQueryBuilder: () => {
              let locked = false;
              let ids: string[] = [];
              const qb = {
                select: () => qb,
                addSelect: () => qb,
                where: () => qb,
                andWhere: (_sql: string, p: { userIds: string[] }) => {
                  ids = p.userIds;
                  return qb;
                },
                setLock: (mode: string) => {
                  locked = mode === 'pessimistic_read';
                  return qb;
                },
                getRawMany: async () => {
                  const rows = ids
                    .filter((id) => roster.has(id))
                    .map((id) => ({ userId: id, joinedAt: roster.get(id) as Date }));
                  if (locked) {
                    for (const r of rows) {
                      shareLocks.set(r.userId, new Promise<void>((res) => releases.push(res)));
                    }
                  }
                  return rows;
                },
              };
              return qb;
            },
          }),
          createQueryBuilder: () => {
            let values: Array<{ userId: string; joinedAt: Date }> = [];
            const ib = {
              insert: () => ib,
              into: () => ib,
              values: (v: Array<{ userId: string; joinedAt: Date }>) => {
                values = v;
                return ib;
              },
              orIgnore: () => ib,
              returning: () => ib,
              execute: async () => {
                await insertGate;
                const raw: Array<{ userId: string; joinedAt: Date }> = [];
                for (const v of values) {
                  // The partial unique index: one OPEN interval per person, a conflict is ignored.
                  if (intervals.some((i) => i.userId === v.userId && i.leftAt === null)) continue;
                  intervals.push({ userId: v.userId, joinedAt: v.joinedAt, leftAt: null });
                  raw.push({ userId: v.userId, joinedAt: v.joinedAt });
                }
                return { raw };
              },
            };
            return ib;
          },
        };
        try {
          return await fn(tx);
        } finally {
          for (const release of releases) release();
        }
      },
      // The group's seat generation the removal stamps on the interval it closes.
      query: async () => [{ seatGeneration: 1 }],
      getRepository: (entity: unknown) => ({
        delete: async ({ userId }: { userId: string }) => {
          await shareLocks.get(userId); // DELETE waits for a FOR SHARE holder
          return { affected: roster.delete(userId) ? 1 : 0 };
        },
        update: async ({ userId }: { userId: string }, set: { leftAt: Date }) => {
          expect(entity).toBe(GroupMembershipInterval);
          let affected = 0;
          for (const i of intervals) {
            if (i.userId === userId && i.leftAt === null) {
              i.leftAt = set.leftAt;
              affected++;
            }
          }
          return { affected };
        },
      }),
    }) as unknown as EntityManager;

  beforeEach(() => {
    roster = new Map([['dave', ARRIVED]]);
    // Removed on the 3rd, re-added on the 5th by an enrolment interrupted before its interval.
    intervals = [
      {
        userId: 'dave',
        joinedAt: new Date('2026-10-01T00:00:00Z'),
        leftAt: new Date('2026-10-03T00:00:00Z'),
      },
    ];
    shareLocks = new Map();
    insertGate = Promise.resolve();
  });

  it('opens the interval from the roster row, and says so only for what it stored', async () => {
    const m = manager();

    expect(await openMissingIntervals(m, G, ['dave'])).toEqual([
      { userId: 'dave', joinedAt: ARRIVED, leftAt: null },
    ]);
    // A second repair hits the conflict: nothing stored, nothing returned, nothing to log.
    expect(await openMissingIntervals(m, G, ['dave'])).toEqual([]);
    expect(intervals.filter((i) => i.leftAt === null)).toHaveLength(1);
  });

  it('opens nothing for a person the roster no longer holds', async () => {
    roster.clear();

    expect(await openMissingIntervals(manager(), G, ['dave'])).toEqual([]);
    expect(intervals.filter((i) => i.leftAt === null)).toEqual([]);
  });

  it('a removal committing between the roster read and the insert closes the repaired interval - never an orphan open one', async () => {
    let openGate!: () => void;
    insertGate = new Promise<void>((res) => (openGate = res));
    const m = manager();

    const repair = openMissingIntervals(m, G, ['dave']);
    await new Promise((r) => setImmediate(r)); // the roster has been read; the insert waits
    const removal = endGroupMembership(m, G, 'dave');
    await new Promise((r) => setImmediate(r));
    openGate();
    await repair;
    const ended = await removal;

    // Unlocked, the removal ran first, closed nothing, and the insert left an OPEN interval with no
    // roster row - which a re-add's ignored conflict would keep, so no window covered the removal.
    expect(ended).toEqual({ deleted: 1, closed: 1 });
    expect(intervals.filter((i) => i.leftAt === null)).toEqual([]);
  });
});

describe('exclusionWindows', () => {
  const at = (iso: string) => new Date(iso);

  it('a member with one open interval has NO window - a new device or a wipe opens nothing', () => {
    expect(exclusionWindows([{ joinedAt: at('2026-10-01T10:00:00Z'), leftAt: null }])).toEqual([]);
  });

  it('removed then re-added: the window is from the removal to the re-add', () => {
    const windows = exclusionWindows([
      // Given out of order on purpose: the database promises no order.
      { joinedAt: at('2026-10-05T12:00:00Z'), leftAt: null },
      { joinedAt: at('2026-10-01T10:00:00Z'), leftAt: at('2026-10-03T09:00:00Z') },
    ]);
    expect(windows).toEqual([
      { from: at('2026-10-03T09:00:00Z').getTime(), until: at('2026-10-05T12:00:00Z').getTime() },
    ]);
  });

  it('still out: the window is open-ended', () => {
    expect(
      exclusionWindows([
        { joinedAt: at('2026-10-01T10:00:00Z'), leftAt: at('2026-10-03T09:00:00Z') },
      ])
    ).toEqual([{ from: at('2026-10-03T09:00:00Z').getTime(), until: null }]);
  });

  it('the time before the FIRST arrival is never a GAP - that span is withheldWindows, not this', () => {
    const windows = exclusionWindows([{ joinedAt: at('2026-10-09T10:00:00Z'), leftAt: null }]);
    expect(windows).toEqual([]);
  });

  it('two removals, two windows', () => {
    const windows = exclusionWindows([
      { joinedAt: at('2026-10-01T00:00:00Z'), leftAt: at('2026-10-02T00:00:00Z') },
      { joinedAt: at('2026-10-03T00:00:00Z'), leftAt: at('2026-10-04T00:00:00Z') },
      { joinedAt: at('2026-10-05T00:00:00Z'), leftAt: null },
    ]);
    expect(windows).toHaveLength(2);
    expect(windows[1]).toEqual({
      from: at('2026-10-04T00:00:00Z').getTime(),
      until: at('2026-10-05T00:00:00Z').getTime(),
    });
  });
});

describe('withheldWindows', () => {
  const at = (iso: string) => new Date(iso);

  it('a group conversation withholds everything before the first arrival, then the gaps', () => {
    // Out of order on purpose, as above.
    const windows = withheldWindows(
      [
        { joinedAt: at('2026-10-05T00:00:00Z'), leftAt: null },
        { joinedAt: at('2026-10-01T00:00:00Z'), leftAt: at('2026-10-03T00:00:00Z') },
      ],
      true,
      null
    );
    expect(windows).toEqual([
      { from: 0, until: at('2026-10-01T00:00:00Z').getTime() },
      { from: at('2026-10-03T00:00:00Z').getTime(), until: at('2026-10-05T00:00:00Z').getTime() },
    ]);
  });

  it('a 1:1 withholds the gaps only - its recorded arrivals are not arrivals', () => {
    expect(
      withheldWindows([{ joinedAt: at('2026-10-09T10:00:00Z'), leftAt: null }], false, null)
    ).toEqual([]);
  });

  it('an EARLIER device row is the arrival - the 4 production members whose interval was recorded late', () => {
    expect(
      withheldWindows(
        [{ joinedAt: at('2026-10-12T00:00:00Z'), leftAt: null }],
        true,
        at('2026-10-01T04:00:00Z')
      )
    ).toEqual([{ from: 0, until: at('2026-10-01T04:00:00Z').getTime() }]);
  });

  it("an interval's recorded admission is the arrival once the device row it came from is gone", () => {
    // The device row was purged (its device revoked); the interval kept the instant it was admitted.
    expect(
      withheldWindows(
        [
          {
            joinedAt: at('2026-10-12T00:00:00Z'),
            leftAt: null,
            admittedAt: at('2026-10-01T04:00:00Z'),
          },
        ],
        true,
        at('2026-10-15T00:00:00Z')
      )
    ).toEqual([{ from: 0, until: at('2026-10-01T04:00:00Z').getTime() }]);
  });

  it('a recorded admission moves no gap - the 2026-10-14 window still ends at the re-enrolment', () => {
    expect(
      withheldWindows(
        [
          { joinedAt: at('2026-10-01T00:00:00Z'), leftAt: at('2026-10-03T00:00:00Z') },
          {
            joinedAt: at('2026-10-05T00:00:00Z'),
            leftAt: null,
            admittedAt: at('2026-10-04T00:00:00Z'),
          },
        ],
        true,
        null
      )
    ).toEqual([
      { from: 0, until: at('2026-10-01T00:00:00Z').getTime() },
      { from: at('2026-10-03T00:00:00Z').getTime(), until: at('2026-10-05T00:00:00Z').getTime() },
    ]);
  });

  it('a device row admitted before any interval opened is the arrival', () => {
    expect(withheldWindows([], true, at('2026-10-20T00:00:00Z'))).toEqual([
      { from: 0, until: at('2026-10-20T00:00:00Z').getTime() },
    ]);
  });

  it('a person with neither an interval nor a device row is withheld everything, open-ended', () => {
    expect(withheldWindows([], true, null)).toEqual([{ from: 0, until: null }]);
  });

  // THE CREATOR ARRIVES WITH THE GROUP, so nothing precedes them and the span is empty - yet a client
  // reads an UNDATED copy against every window edge with a one-hour skew margin, so `[0, creation)`
  // dropped every undated history entry of the group's first hour on the creator (GRP-7, 2026-10-22).
  // Measured on the local estate: the creator's interval 4 ms after `createdAt`, the next member 13.5 s.
  const created = at('2026-10-22T04:50:00.000Z');

  it('the person who arrived WITH the group has no before-arrival span', () => {
    expect(
      withheldWindows(
        [{ joinedAt: at('2026-10-22T04:50:00.004Z'), leftAt: null }],
        true,
        null,
        created
      )
    ).toEqual([]);
  });

  it('a device row written a moment BEFORE the group row (two clocks) is still the creation', () => {
    expect(
      withheldWindows(
        [{ joinedAt: at('2026-10-22T04:50:00.004Z'), leftAt: null }],
        true,
        at('2026-10-22T04:49:59.990Z'),
        created
      )
    ).toEqual([]);
  });

  it("the creator's later gaps are still withheld", () => {
    expect(
      withheldWindows(
        [
          { joinedAt: at('2026-10-22T04:50:00.004Z'), leftAt: at('2026-10-22T06:00:00Z') },
          { joinedAt: at('2026-10-22T07:00:00Z'), leftAt: null },
        ],
        true,
        null,
        created
      )
    ).toEqual([
      { from: at('2026-10-22T06:00:00Z').getTime(), until: at('2026-10-22T07:00:00Z').getTime() },
    ]);
  });

  it("a joiner's protection is unchanged: arriving 13.5 s after the group keeps the span", () => {
    expect(
      withheldWindows(
        [{ joinedAt: at('2026-10-22T04:50:13.504Z'), leftAt: null }],
        true,
        null,
        created
      )
    ).toEqual([{ from: 0, until: at('2026-10-22T04:50:13.504Z').getTime() }]);
  });

  it('a 1:1 is untouched by the creation rule', () => {
    expect(
      withheldWindows(
        [{ joinedAt: at('2026-10-22T04:50:00.004Z'), leftAt: null }],
        false,
        null,
        created
      )
    ).toEqual([]);
  });
});

describe('withholdExcludedHistoryRows', () => {
  const W = [{ from: 1000, until: 2000 }];
  const row = (id: string, ms: number | null) => ({
    id,
    content: `c-${id}`,
    ...(ms === null ? {} : { timestamp: new Date(ms).toISOString() }),
  });

  it('drops a withheld row outright - no id, no marker an older build could trip on', () => {
    const out = withholdExcludedHistoryRows([row('a', 999), row('b', 1000), row('c', 2000)], W);
    expect(out.rows).toEqual([row('a', 999), row('c', 2000)]);
    expect(out.withheld).toBe(1);
  });

  it('withholds a row whose time cannot be read while a window exists, and touches nothing without one', () => {
    expect(withholdExcludedHistoryRows([row('x', null)], W).rows).toEqual([]);
    const untouched = [row('x', null)];
    expect(withholdExcludedHistoryRows(untouched, []).rows).toBe(untouched);
  });
});

/**
 * EVERY PATH THAT ENDS A DEVICE'S MEMBERSHIP TAKES ITS QUEUED WELCOMES WITH IT, through this one
 * helper. A device pulls its queue whatever the roster says, so a Welcome left behind lets a device
 * that is out enter the epoch the Welcome was built for.
 *
 * Asserted on the SQL the real TypeORM query builder produces (`recordingDataSource`): a delete
 * whose filter lost a column is a delete of other people's rows, and only the real criteria
 * handling can show which column survived.
 */
describe('endDeviceMemberships', () => {
  it('deletes the device rows and the queued Welcomes of exactly the scope it is given', async () => {
    const { manager, statements } = await recordingDataSource();

    await endDeviceMemberships(
      manager,
      { userId: 'bob', deviceId: 'b1', groupId: 'g-1' },
      'welcomes'
    );

    // The queue before the device rows: the one delete order (`utils/seat-eviction.ts`).
    expect(statements.map((s) => [s.sql, s.params])).toEqual([
      [
        'DELETE FROM "queued_message" WHERE ("recipientId" = $1 AND "deviceId" = $2 AND "groupId" = $3 AND "isWelcome" = $4)',
        ['bob', 'b1', 'g-1', true],
      ],
      [
        'DELETE FROM "dm_device_group_memberships" WHERE ("userId" = $1 AND "deviceId" = $2 AND "groupId" = $3)',
        ['bob', 'b1', 'g-1'],
      ],
    ]);
  });

  it('widens to the whole queue of that scope when the departure takes everything', async () => {
    const { manager, statements } = await recordingDataSource();

    await endDeviceMemberships(manager, { userId: 'bob', groupId: 'g-1' }, 'all');

    expect(statements[0]).toEqual({
      sql: 'DELETE FROM "queued_message" WHERE ("recipientId" = $1 AND "groupId" = $2)',
      params: ['bob', 'g-1'],
    });
  });

  it.each([
    ['an empty userId', { userId: '' }],
    ['an undefined userId', { userId: undefined as unknown as string }],
    ['a blank userId', { userId: '  ' }],
    ['an empty deviceId it names', { userId: 'bob', deviceId: '' }],
    ['an undefined deviceId it names', { userId: 'bob', deviceId: undefined }],
    ['an empty groupId it names', { userId: 'bob', groupId: '' }],
    ['a null groupId it names', { userId: 'bob', groupId: null as unknown as string }],
  ])('refuses %s, before any statement is built', async (_name, scope) => {
    const { manager, statements } = await recordingDataSource();

    await expect(endDeviceMemberships(manager, scope, 'all')).rejects.toThrow(
      /endDeviceMemberships: /
    );
    expect(statements).toEqual([]);
  });
});

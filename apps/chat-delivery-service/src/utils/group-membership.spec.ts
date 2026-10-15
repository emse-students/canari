/// <reference types="jest" />

import type { EntityManager } from 'typeorm';
import {
  endGroupMembership,
  ensureGroupMember,
  exclusionWindows,
  withholdExcludedHistoryRows,
} from './group-membership';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';

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

  /** Records every INSERT the helper builds, one entry per `insert()`. */
  function managerWithRecorder(): { manager: EntityManager; inserts: Insert[] } {
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
    builder.execute = () => {
      current().calls.push('execute');
      return Promise.resolve({ affected: 1 });
    };

    const manager = { createQueryBuilder: () => builder } as unknown as EntityManager;
    return { manager, inserts };
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
    });
  });

  it('opens an OPEN membership interval, and a second enrolment is a no-op on it too', async () => {
    const { manager, inserts } = managerWithRecorder();
    const before = Date.now();

    await ensureGroupMember(manager, 'g-1', 'alice');

    const interval = inserts.find((i) => i.target === GroupMembershipInterval);
    const { joinedAt, ...rest } = interval?.values ?? {};
    expect(rest).toEqual({ groupId: 'g-1', userId: 'alice', leftAt: null });
    // The same clock as the message's `createdAt` - this process's - so a window and the
    // messages it is compared with are placed by ONE clock.
    expect(joinedAt).toBeInstanceOf(Date);
    expect((joinedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    // The partial unique index refuses a second open interval; the insert must ignore that refusal
    // exactly as the membership row ignores its own conflict.
    expect(interval?.calls).toContain('orIgnore');
    expect(interval?.calls).not.toContain('orUpdate');
  });
});

describe('endGroupMembership', () => {
  it('deletes the live row AND closes the open interval at the clock that dates messages', async () => {
    const before = Date.now();
    const deletes: Array<{ entity: unknown; where: unknown }> = [];
    const updates: Array<{ entity: unknown; where: Record<string, unknown>; set: unknown }> = [];
    const manager = {
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
    const set = updates[0].set as { leftAt: Date };
    expect(set.leftAt).toBeInstanceOf(Date);
    expect(set.leftAt.getTime()).toBeGreaterThanOrEqual(before);
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

  it('the time before the FIRST arrival is never a window - a late joiner keeps the existing policy', () => {
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

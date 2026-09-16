/// <reference types="jest" />

import type { EntityManager } from 'typeorm';
import { ensureGroupMember } from './group-membership';
import { GroupMember } from '../entities/group-member.entity';

/**
 * The statement this helper builds is the whole of what it does, so the statement is what is
 * asserted: an INSERT that says nothing on conflict, and values that never name `joinedAt`.
 *
 * Both halves matter for the same reason. `ON CONFLICT DO UPDATE SET "joinedAt"` is how a
 * production group ended up with no row carrying its own creation minute, and passing `joinedAt`
 * explicitly is how the column stopped being written by the `@CreateDateColumn` that defines it.
 * Neither would fail a behavioural test - nothing reads the column - which is precisely why the
 * shape is pinned here.
 */
describe('ensureGroupMember', () => {
  type Recorder = {
    calls: string[];
    values: Record<string, unknown> | undefined;
    target: unknown;
  };

  function managerWithRecorder(): { manager: EntityManager; rec: Recorder } {
    const rec: Recorder = { calls: [], values: undefined, target: undefined };
    const builder: Record<string, unknown> = {};
    const step = (name: string, capture?: (arg: unknown) => void) => (arg?: unknown) => {
      rec.calls.push(name);
      capture?.(arg);
      return builder;
    };
    builder.insert = step('insert');
    builder.into = step('into', (arg) => {
      rec.target = arg;
    });
    builder.values = step('values', (arg) => {
      rec.values = arg as Record<string, unknown>;
    });
    builder.orIgnore = step('orIgnore');
    builder.orUpdate = step('orUpdate');
    builder.execute = () => {
      rec.calls.push('execute');
      return Promise.resolve({ affected: 1 });
    };

    const manager = { createQueryBuilder: () => builder } as unknown as EntityManager;
    return { manager, rec };
  }

  it('inserts into dm_group_members and says nothing on conflict', async () => {
    const { manager, rec } = managerWithRecorder();

    await ensureGroupMember(manager, 'g-1', 'alice');

    expect(rec.target).toBe(GroupMember);
    expect(rec.calls).toContain('orIgnore');
    expect(rec.calls).not.toContain('orUpdate');
    expect(rec.calls[rec.calls.length - 1]).toBe('execute');
  });

  it('never writes joinedAt itself - the column belongs to the insert that created the row', async () => {
    const { manager, rec } = managerWithRecorder();

    await ensureGroupMember(manager, 'g-1', 'alice');

    expect(rec.values).toEqual({ groupId: 'g-1', userId: 'alice', role: 'member' });
    expect(Object.keys(rec.values ?? {})).not.toContain('joinedAt');
  });
});

import type { EntityManager } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import {
  joinAskAnnouncementsSettled,
  pushJoinAsk,
  JOIN_ASK_CONTENT_KEY,
} from './join-ask-announce';

/**
 * ONE ORDINARY PUSH PER JOIN ASK, to the admitted members, never to the joiner. The claim is the
 * seat row's `joinAskNotified`, flipped by a conditional UPDATE - so these tests run the real
 * decision over an in-memory table with that exact semantics, and wait on the announcement's own
 * settlement hook instead of a clock.
 */
const GROUP = '7e931024-0000-4000-8000-000000000001';

interface Seat {
  id: string;
  groupId: string;
  userId: string;
  awaitingAdmission: boolean;
  joinAskNotified: boolean;
  notifLevel: string;
}

function seat(id: string, userId: string, over: Partial<Seat> = {}): Seat {
  return {
    id,
    groupId: GROUP,
    userId,
    awaitingAdmission: false,
    joinAskNotified: false,
    notifLevel: 'all',
    ...over,
  };
}

/** Just enough of an EntityManager: the seat table, one group, and the users' names. */
function fakeManager(seats: Seat[], names: Record<string, string> = {}) {
  const matches = (row: Seat, where: Partial<Seat>) =>
    Object.entries(where).every(([k, v]) => row[k as keyof Seat] === v);
  const memberRepo = {
    update: async (where: Partial<Seat>, set: Partial<Seat>) => {
      const hit = seats.filter((s) => matches(s, where));
      hit.forEach((s) => Object.assign(s, set));
      return { affected: hit.length };
    },
    find: async ({ where }: { where: Partial<Seat> }) => seats.filter((s) => matches(s, where)),
  };
  const groupRepo = {
    findOne: async () => ({ name: 'Club photo', isGroup: true }),
  };
  return {
    getRepository: (entity: unknown) => (entity === GroupMember ? memberRepo : groupRepo),
    findOne: async (entity: unknown, opts: { where: Partial<Seat> }) =>
      entity === GroupMember ? (seats.find((s) => matches(s, opts.where)) ?? null) : null,
    query: async (_sql: string, [id]: [string]) =>
      names[id] ? [{ id, displayName: names[id], firstName: null, lastName: null }] : [],
  } as unknown as EntityManager;
}

const ASK = { userId: 'carol', askId: 'seat-carol' };
const sender = () => jest.fn(async () => ({ sent: 1, failed: 0 }));

describe('pushJoinAsk', () => {
  it('sends one ordinary push to each admitted member, naming the asker and the group', async () => {
    const seats = [
      seat('s1', 'alice'),
      seat('s2', 'bob'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ];
    const push = sender();

    pushJoinAsk(fakeManager(seats, { carol: 'Carol Dupont' }), GROUP, ASK, push);
    await joinAskAnnouncementsSettled();

    expect(push).toHaveBeenCalledTimes(2);
    const [userId, title, body, data] = push.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, string>,
    ];
    expect(userId).toBe('alice');
    expect(title).toBe('Carol Dupont');
    expect(body).toBe('Carol Dupont veut rejoindre Club photo');
    expect(data).toMatchObject({
      type: 'social',
      contentKey: JOIN_ASK_CONTENT_KEY,
      actorName: 'Carol Dupont',
      contentArg: 'Club photo',
      groupId: GROUP,
      deepLink: `fr.emse.canari://chat/${GROUP}`,
    });
  });

  it('never pushes the joiner, nor a seat that itself awaits a member', async () => {
    const seats = [
      seat('s1', 'alice'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
      seat('s3', 'dave', { awaitingAdmission: true }),
    ];
    const push = sender();

    pushJoinAsk(fakeManager(seats), GROUP, ASK, push);
    await joinAskAnnouncementsSettled();

    expect(push.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['alice']);
  });

  it('is sent ONCE per ask: a second raise of the same askId sends nothing', async () => {
    const seats = [seat('s1', 'alice'), seat('seat-carol', 'carol', { awaitingAdmission: true })];
    const manager = fakeManager(seats);
    const push = sender();

    pushJoinAsk(manager, GROUP, ASK, push);
    pushJoinAsk(manager, GROUP, ASK, push);
    await joinAskAnnouncementsSettled();
    pushJoinAsk(manager, GROUP, ASK, push);
    await joinAskAnnouncementsSettled();

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('sends a new push for a fresh ask after a Decline: a new seat is a new askId', async () => {
    const seats = [seat('s1', 'alice'), seat('seat-carol', 'carol', { awaitingAdmission: true })];
    const manager = fakeManager(seats);
    const push = sender();
    pushJoinAsk(manager, GROUP, ASK, push);
    await joinAskAnnouncementsSettled();

    // The Decline deleted the seat; following the link again wrote a new row.
    seats.splice(1, 1, seat('seat-carol-2', 'carol', { awaitingAdmission: true }));
    pushJoinAsk(manager, GROUP, { userId: 'carol', askId: 'seat-carol-2' }, push);
    await joinAskAnnouncementsSettled();

    expect(push).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an ask a member already answered (the seat no longer awaits)', async () => {
    const seats = [seat('s1', 'alice'), seat('seat-carol', 'carol')];
    const push = sender();

    pushJoinAsk(fakeManager(seats), GROUP, ASK, push);
    await joinAskAnnouncementsSettled();

    expect(push).not.toHaveBeenCalled();
  });

  it('skips a member who muted the conversation, and one failing push costs no other member theirs', async () => {
    const seats = [
      seat('s1', 'alice', { notifLevel: 'none' }),
      seat('s2', 'bob'),
      seat('s3', 'erin'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ];
    const push = jest.fn(async (userId: string) => {
      if (userId === 'bob') throw new Error('fcm down');
      return { sent: 1, failed: 0 };
    });

    pushJoinAsk(fakeManager(seats), GROUP, ASK, push);
    await joinAskAnnouncementsSettled();

    expect(push.mock.calls.map((c) => c[0])).toEqual(['bob', 'erin']);
  });
});

// `Group` is imported so a rename of the entity breaks this spec rather than the fake silently.
void Group;

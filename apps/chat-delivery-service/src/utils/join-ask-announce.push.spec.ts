import type { EntityManager } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';
import {
  joinAskAnnouncementsSettled,
  pushJoinAsk,
  JOIN_ASK_CONTENT_KEY,
} from './join-ask-announce';

/**
 * ONE ORDINARY PUSH PER MEMBER DECLINE, to the admitted members, never to the joiner. The claim is
 * a row keyed (group, person) compared against the person's Decline counter, so these tests run the
 * real decision over an in-memory model of exactly that table, and wait on the announcement's own
 * settlement hook instead of a clock.
 */
const GROUP = '7e931024-0000-4000-8000-000000000001';

interface Seat {
  id: string;
  groupId: string;
  userId: string;
  awaitingAdmission: boolean;
  notifLevel: string;
}

function seat(id: string, userId: string, over: Partial<Seat> = {}): Seat {
  return { id, groupId: GROUP, userId, awaitingAdmission: false, notifLevel: 'all', ...over };
}

interface World {
  seats: Seat[];
  names: Record<string, string>;
  /** `declinedAtSeatGeneration` per person (absent: none), moved only by a member's Decline. */
  declined: Record<string, number>;
  /** The claim table: gen per person. */
  pushes: Map<string, number>;
  /** Pairs between whom a block stands, as `a|b` in either order. */
  blocks: Set<string>;
}

const world = (seats: Seat[], over: Partial<World> = {}): World => ({
  seats,
  names: {},
  declined: {},
  pushes: new Map(),
  blocks: new Set(),
  ...over,
});

/** Just enough of an EntityManager over a {@link World}. */
function fakeManager(w: World) {
  const matches = (row: Seat, where: Partial<Seat>) =>
    Object.entries(where).every(([k, v]) => row[k as keyof Seat] === v);
  const memberRepo = {
    findOne: async ({ where }: { where: Partial<Seat> }) =>
      w.seats.find((s) => matches(s, where)) ?? null,
    find: async ({ where }: { where: Partial<Seat> }) => w.seats.filter((s) => matches(s, where)),
  };
  const groupRepo = { findOne: async () => ({ name: 'Club photo', isGroup: true }) };
  return {
    getRepository: (entity: unknown) => (entity === GroupMember ? memberRepo : groupRepo),
    findOne: async (entity: unknown, opts: { where: Partial<Seat> }) =>
      entity === GroupMember ? (w.seats.find((s) => matches(s, opts.where)) ?? null) : null,
    query: async (sql: string, params: string[]) => {
      if (sql.includes('INSERT INTO dm_join_ask_pushes')) {
        const [, userId] = params as [string, string];
        const gen = w.declined[userId] ?? 0;
        const had = w.pushes.get(userId);
        // INSERT ... ON CONFLICT DO UPDATE ... WHERE old < new RETURNING 1
        if (had === undefined || had < gen) {
          w.pushes.set(userId, gen);
          return [{ '?column?': 1 }];
        }
        return [];
      }
      if (sql.includes('FROM user_blocks')) {
        const [a, b] = params as [string, string];
        return w.blocks.has(`${a}|${b}`) || w.blocks.has(`${b}|${a}`) ? [{}] : [];
      }
      if (sql.includes('FROM users')) {
        const [id] = params as [string];
        return w.names[id]
          ? [{ id, displayName: w.names[id], firstName: null, lastName: null }]
          : [];
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  } as unknown as EntityManager;
}

const ASK = { userId: 'carol', askId: 'seat-carol' };
const sender = () => jest.fn(async (..._a: unknown[]) => ({ sent: 1, failed: 0 }));
const pushedTo = (push: ReturnType<typeof sender>) => push.mock.calls.map((c) => c[0]);

async function raise(w: World, push: ReturnType<typeof sender>, ask = ASK) {
  pushJoinAsk(fakeManager(w), GROUP, ask, push as never);
  await joinAskAnnouncementsSettled();
}

describe('pushJoinAsk', () => {
  it('sends one ordinary push to each admitted member, naming the asker and the group', async () => {
    const w = world(
      [
        seat('s1', 'alice'),
        seat('s2', 'bob'),
        seat('seat-carol', 'carol', { awaitingAdmission: true }),
      ],
      { names: { carol: 'Carol Dupont' } }
    );
    const push = sender();

    await raise(w, push);

    expect(pushedTo(push)).toEqual(['alice', 'bob']);
    const [, title, body, data] = push.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, string>,
    ];
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
    const w = world([
      seat('s1', 'alice'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
      seat('s3', 'dave', { awaitingAdmission: true }),
    ]);
    const push = sender();

    await raise(w, push);

    expect(pushedTo(push)).toEqual(['alice']);
  });

  it('is sent ONCE: a second raise of the same ask sends nothing', async () => {
    const w = world([
      seat('s1', 'alice'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ]);
    const push = sender();

    await raise(w, push);
    await raise(w, push);

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('THE LOOP: accept, self-remove, accept again pushes ONCE - the joiner cannot re-arm it', async () => {
    const w = world([
      seat('s1', 'alice'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ]);
    const push = sender();
    await raise(w, push);

    // The joiner withdraws (seat deleted, no member Decline: the counter does not move) and follows
    // the link again: a NEW seat row, a new askId.
    w.seats.splice(1, 1, seat('seat-carol-2', 'carol', { awaitingAdmission: true }));
    await raise(w, push, { userId: 'carol', askId: 'seat-carol-2' });
    w.seats.splice(1, 1, seat('seat-carol-3', 'carol', { awaitingAdmission: true }));
    await raise(w, push, { userId: 'carol', askId: 'seat-carol-3' });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('sends again after a MEMBER declined them: only a Decline moves the counter', async () => {
    const w = world([
      seat('s1', 'alice'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ]);
    const push = sender();
    await raise(w, push);

    w.declined.carol = 7; // a member's Decline, at the group's seat generation
    w.seats.splice(1, 1, seat('seat-carol-2', 'carol', { awaitingAdmission: true }));
    await raise(w, push, { userId: 'carol', askId: 'seat-carol-2' });
    // A re-follow after that Decline's push, with no further Decline: nothing more.
    w.seats.splice(1, 1, seat('seat-carol-3', 'carol', { awaitingAdmission: true }));
    await raise(w, push, { userId: 'carol', askId: 'seat-carol-3' });

    expect(push).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for an ask a member already answered (the seat no longer awaits)', async () => {
    const w = world([seat('s1', 'alice'), seat('seat-carol', 'carol')]);
    const push = sender();

    await raise(w, push);

    expect(push).not.toHaveBeenCalled();
  });

  it('skips a member who muted the conversation, and one failing push costs no other member theirs', async () => {
    const w = world([
      seat('s1', 'alice', { notifLevel: 'none' }),
      seat('s2', 'bob'),
      seat('s3', 'erin'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ]);
    const push = jest.fn(async (userId: unknown) => {
      if (userId === 'bob') throw new Error('fcm down');
      return { sent: 1, failed: 0 };
    });

    await raise(w, push as never);

    expect(pushedTo(push as never)).toEqual(['bob', 'erin']);
  });

  it('skips a recipient when a block stands between them and the asker, in either direction', async () => {
    const w = world(
      [
        seat('s1', 'alice'),
        seat('s2', 'bob'),
        seat('s3', 'erin'),
        seat('seat-carol', 'carol', { awaitingAdmission: true }),
      ],
      { blocks: new Set(['alice|carol', 'carol|bob']) }
    );
    const push = sender();

    await raise(w, push);

    expect(pushedTo(push)).toEqual(['erin']);
  });

  it('NEVER puts an id on the lock screen: with no resolvable name the actor is empty', async () => {
    const w = world([
      seat('s1', 'alice'),
      seat('seat-carol', 'carol', { awaitingAdmission: true }),
    ]);
    const push = sender();

    await raise(w, push);

    const [, title, body, data] = push.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, string>,
    ];
    expect(data.actorName).toBe('');
    expect(title).not.toContain('carol');
    expect(body).toBe("Quelqu'un veut rejoindre Club photo");
  });
});

/**
 * EVENT CO-ORGANISATION BY PROPOSAL (D39), against a REAL PostgreSQL - migrations 071 to 074.
 *
 * The services run for real: `AssociationsService` (the event write, the rights through
 * `findCalendarEventForAssociation`, `mayAct`, and the signed-in agenda through
 * `listAggregatedCalendarFeed` / `listCalendarEvents`), `ProposalsService` and
 * `CoorganisationService`, over a TypeORM connection whose association and event tables are built by
 * `synchronize` - the way production's were - so the migration meets the shape it will meet there.
 * Only the notifications are recorded rather than sent.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- coorganisation.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import { Association } from '../associations/entities/association.entity';
import {
  AssociationMember,
  AssociationPermissionFlag,
} from '../associations/entities/association-member.entity';
import { AssociationCalendarEvent } from '../associations/entities/association-calendar-event.entity';
import { AssociationCalendarEventCoOwner } from '../associations/entities/association-calendar-event-co-owner.entity';
import { Form } from '../forms/entities/form.entity';
import { Submission } from '../forms/entities/submission.entity';
import type { PostNotificationsService } from '../posts/post-notifications.service';
import { Proposal } from '../proposals/proposal.entity';
import { ProposalsService } from '../proposals/proposals.service';
import { type ErasureDb, eraseSocialRows } from '../internal/account-erasure';
import { CoorganisationService } from './coorganisation.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const PROPOSE = AssociationPermissionFlag.PROPOSE_EVENT;
const POST_AS = AssociationPermissionFlag.POST_AS_ASSO;

const A1 = '00000000-0000-4000-8000-0000000c0a01'; // organiser, (ICM, saint-etienne)
const A2 = '00000000-0000-4000-8000-0000000c0a02'; // a legacy co-owner, (ICM, saint-etienne)
const A3 = '00000000-0000-4000-8000-0000000c0a03'; // asked to co-organise, (NULL, gardanne)
const A4 = '00000000-0000-4000-8000-0000000c0a04'; // another association, (NULL, gardanne)

const E = (n: number) => `00000000-0000-4000-8000-0000000ce${String(n).padStart(3, '0')}`;

/** The cast. Readable ids: a failure names a person. */
const USERS: Record<string, { campus: string | null; formation: string | null }> = {
  org: { campus: 'saint-etienne', formation: 'ICM' }, // PROPOSE_EVENT in A1
  legacyEd: { campus: 'saint-etienne', formation: 'ICM' }, // PROPOSE_EVENT in A2
  coPub: { campus: 'gardanne', formation: 'ISMIN' }, // POST_AS_ASSO + PROPOSE_EVENT in A3
  coEd: { campus: 'gardanne', formation: 'ISMIN' }, // PROPOSE_EVENT only in A3
  gaReader: { campus: 'gardanne', formation: 'ISMIN' }, // reached by A3's rule only
  seReader: { campus: 'saint-etienne', formation: 'ICM' }, // reached by A1's rule
  nobody: { campus: null, formation: null }, // no space, no membership
};

maybe('event co-organisation against PostgreSQL (migrations 071-074)', () => {
  const schema = `coorg_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let associations: AssociationsService;
  let proposals: ProposalsService;
  let coorg: CoorganisationService;
  const told: { type: string; postId: string; recipientIds: string[]; text?: string }[] = [];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** The agenda a signed-in reader is served, as event ids. */
  async function agendaOf(userId: string): Promise<string[]> {
    const rows = await associations.listAggregatedCalendarFeed(
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T00:00:00.000Z',
      undefined,
      { viewer: { userId } }
    );
    return rows.map((r) => r.id).sort();
  }

  async function proposalRows(eventId: string) {
    return (await q(
      `SELECT "toAssociationId", status, "decidedBy" FROM proposals
        WHERE kind = 'coorganise' AND "subjectId" = $1 ORDER BY "createdAt", "toAssociationId"`,
      [eventId]
    )) as { toAssociationId: string; status: string; decidedBy: string | null }[];
  }

  async function coOwnersOf(eventId: string): Promise<string[]> {
    const rows: { association_id: string }[] = await q(
      `SELECT association_id FROM association_calendar_event_co_owners WHERE event_id = $1 ORDER BY 1`,
      [eventId]
    );
    return rows.map((r) => r.association_id);
  }

  const update = (via: string, eventId: string, coOwnerIds: string[], userId: string) =>
    associations.updateCalendarEvent(via, eventId, { coOwnerIds }, { callerUserId: userId });

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        Association,
        AssociationMember,
        AssociationCalendarEvent,
        AssociationCalendarEventCoOwner,
        Proposal,
        // What an association delete retires with it (`retireForms`).
        Form,
        Submission,
      ],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public`, application_name: schema },
    });
    await ds.initialize();
    // The tables production's `synchronize` built - minus `proposals`, which 073 creates.
    await ds.synchronize();
    await q(`DROP TABLE proposals`);
    // Production's co-owner table has NO unique key (the entity's index is 074's): drop it, so the
    // migration meets duplicates the way it would there.
    await q(`DROP INDEX IF EXISTS "UQ_calendar_event_co_owner"`);
    await q(`
      CREATE TABLE users (id varchar(255) PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
        campus varchar(32), cursus jsonb NOT NULL DEFAULT '[]', promo int);
      CREATE TABLE posts (id uuid PRIMARY KEY, "authorId" varchar(255) NOT NULL, "associationId" uuid);
      ALTER TABLE associations ADD COLUMN "isBDE" boolean NOT NULL DEFAULT false;
    `);
    // Only the columns an association delete and the erasure's association lock read: PARTIAL, so
    // the erasure case below runs no statement of its own against them.
    await q(`
      CREATE TABLE booking_spaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "associationId" uuid,
        "ownerId" varchar, poster jsonb);
      CREATE TABLE booking_resources (id uuid PRIMARY KEY, "spaceId" uuid, "linkedUserId" varchar);
      CREATE TABLE bookings (id uuid PRIMARY KEY, "resourceId" uuid, "holderId" varchar,
        "bookedById" varchar, "cancelledById" varchar);
      CREATE TABLE booking_participants ("bookingId" uuid, "userId" varchar);
      CREATE TABLE booking_blocks ("resourceId" uuid, "createdById" varchar);
      CREATE TABLE booking_files ("spaceId" uuid, "uploaderId" varchar);
      CREATE TABLE association_role_history (association_id uuid, user_id varchar);
      CREATE TABLE association_push_mutes ("associationId" uuid, "userId" varchar);
      CREATE TABLE form_respondents ("formId" uuid, "userId" varchar);
      CREATE TABLE lydia_cashiers ("associationId" uuid, "vendorToken" varchar, "userId" varchar,
        "addedByUserId" varchar, "removedAt" timestamptz);
    `);
    for (const [id, name] of [
      [A1, 'Organiser'],
      [A2, 'Legacy'],
      [A3, 'Gardanne club'],
      [A4, 'Other'],
    ]) {
      await q(`INSERT INTO associations (id, name, slug, "createdBy") VALUES ($1, $2, $3, 'it')`, [
        id,
        name,
        name.toLowerCase().replace(/ /g, '-'),
      ]);
    }
    await q(migration('071_spaces.sql'));
    await q(migration('072_drop_is_bde.sql'));
    await q(migration('073_republications.sql'));
    await q(migration('078_read_grants.sql'));
    await q(migration('096_personal_republication_requests.sql'));
    for (const a of [A3, A4]) {
      await q(`DELETE FROM association_audiences WHERE "associationId" = $1`, [a]);
      await q(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, NULL, 'gardanne')`,
        [a]
      );
    }
    for (const [id, u] of Object.entries(USERS)) {
      await q(`INSERT INTO users (id, campus, cursus) VALUES ($1, $2, $3)`, [
        id,
        u.campus,
        JSON.stringify(u.formation ? [{ formation: u.formation, promo: 2024 }] : []),
      ]);
    }
    await q(
      `INSERT INTO association_members ("associationId", "userId", role, permissions) VALUES
         ($1, 'org', 'admin', $5), ($2, 'legacyEd', 'admin', $5), ($3, 'coPub', 'admin', $6),
         ($3, 'coEd', 'admin', $5), ($4, 'coPub', 'admin', $6)`,
      [A1, A2, A3, A4, PROPOSE, POST_AS | PROPOSE]
    );
    // Five validated events of A1 in 2026, and E0 carrying the PRE-074 state: A2 as co-owner TWICE
    // (no unique key existed), plus an orphan row whose event is gone.
    for (let n = 0; n <= 5; n += 1) {
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, $3, '2026-06-0${n + 1}T18:00:00Z', 'org', 'validated')`,
        [E(n), A1, `Event ${n}`]
      );
    }
    await q(
      `INSERT INTO association_calendar_event_co_owners (id, event_id, association_id) VALUES
         (gen_random_uuid(), $1, $2), (gen_random_uuid(), $1, $2), (gen_random_uuid(), $3, $2)`,
      [E(0), A2, E(999)]
    );

    const notifications = {
      createNotifications: (data: {
        type: string;
        postId: string;
        actorId: string;
        recipientIds: string[];
        text?: string;
      }) => {
        const recipientIds = [...new Set(data.recipientIds)].filter((id) => id !== data.actorId);
        told.push({ ...data, recipientIds: recipientIds.sort() });
        return Promise.resolve(recipientIds.length);
      },
    } as unknown as PostNotificationsService;
    const none = {} as never;
    // The feed-cache sweep an association delete ends with: nothing is cached here.
    const redis = { deleteByPattern: () => Promise.resolve(0) } as never;
    associations = new AssociationsService(
      ds.getRepository(Association),
      ds.getRepository(AssociationMember),
      ds.getRepository(AssociationCalendarEvent),
      ds.getRepository(AssociationCalendarEventCoOwner),
      none,
      none,
      none,
      ds.getRepository(Form),
      none,
      redis,
      none,
      notifications,
      none,
      { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
    );
    proposals = new ProposalsService(ds.getRepository(Proposal), associations);
    coorg = new CoorganisationService(
      ds.getRepository(AssociationCalendarEventCoOwner),
      associations,
      notifications,
      proposals
    );
    coorg.onModuleInit();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  beforeEach(() => {
    told.length = 0;
  });

  describe('migration 074 on the pre-074 state', () => {
    it('keeps the existing co-owner as ACCEPTED, de-duplicated, orphans gone, and replays cleanly', async () => {
      await q(migration('074_coorganise.sql'));
      await q(migration('074_coorganise.sql'));
      expect(await coOwnersOf(E(0))).toEqual([A2]);
      expect(await coOwnersOf(E(999))).toEqual([]);
      expect(await proposalRows(E(0))).toEqual([
        { toAssociationId: A2, status: 'accepted', decidedBy: 'migration-074' },
      ]);
      // The backfilled co-owner kept its rights: it reaches the event through its own route.
      expect(await associations.findCalendarEventForAssociation(E(0), A2, false)).not.toBeNull();
      // And its state reads as accepted in the form.
      const states = await coorg.listStatesFor(A1, E(0), 'org', false);
      expect(states.map((s) => [s.associationId, s.status])).toEqual([[A2, 'accepted']]);
    });
  });

  describe('a proposal: no right and no reach until accepted', () => {
    it('the organiser names A3: a pending proposal, told to A3 publishers only', async () => {
      expect(await agendaOf('gaReader')).toEqual([]);
      await update(A1, E(1), [A3], 'org');
      expect(await proposalRows(E(1))).toEqual([
        { toAssociationId: A3, status: 'pending', decidedBy: null },
      ]);
      expect(await coOwnersOf(E(1))).toEqual([]);
      // coEd holds PROPOSE_EVENT but not POST_AS_ASSO: an acceptor is a publisher.
      expect(told).toEqual([
        expect.objectContaining({
          type: 'coorganise_proposed',
          postId: A3,
          recipientIds: ['coPub'],
          text: 'Event 1',
        }),
      ]);
    });

    it('before acceptance: A3 has no right on the event, and its readers do not see it', async () => {
      expect(await associations.findCalendarEventForAssociation(E(1), A3, false)).toBeNull();
      await expect(update(A3, E(1), [], 'coEd')).rejects.toBeInstanceOf(NotFoundException);
      await expect(coorg.listStatesFor(A3, E(1), 'coEd', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(await agendaOf('gaReader')).toEqual([]);
      const own = await associations.listCalendarEvents(A3, undefined, undefined, {
        viewer: { userId: 'gaReader' },
      });
      expect(own).toEqual([]);
    });

    it('resubmitting the same list changes nothing (no second proposal, nobody told)', async () => {
      await update(A1, E(1), [A3], 'org');
      expect(await proposalRows(E(1))).toHaveLength(1);
      expect(told).toEqual([]);
    });

    it('only A3 publishers accept (403 for an editor, for the organiser and for a reader)', async () => {
      const [pending] = (await proposals.listPending(A3, 'coPub', false)).incoming;
      expect(pending.subject).toMatchObject({ title: 'Event 1', associationName: 'Organiser' });
      for (const who of ['coEd', 'org', 'gaReader']) {
        await expect(proposals.accept(pending.id, who, false)).rejects.toBeInstanceOf(
          ForbiddenException
        );
      }
    });

    it('accepted: A3 gains the rights and its audience is added (the union)', async () => {
      const [pending] = (await proposals.listPending(A3, 'coPub', false)).incoming;
      await proposals.accept(pending.id, 'coPub', false);
      expect(await coOwnersOf(E(1))).toEqual([A3]);
      expect(await associations.findCalendarEventForAssociation(E(1), A3, false)).not.toBeNull();
      expect(await agendaOf('gaReader')).toEqual([E(1)]);
      // The organiser's audience keeps it: the union, not a move.
      expect(await agendaOf('seReader')).toContain(E(1));
      expect(await agendaOf('nobody')).toEqual([]);
      const own = await associations.listCalendarEvents(A3, undefined, undefined, {
        viewer: { userId: 'gaReader' },
      });
      expect(own.map((e) => e.id)).toEqual([E(1)]);
      const states = await coorg.listStatesFor(A3, E(1), 'coEd', false);
      expect(states.map((s) => [s.associationId, s.status])).toEqual([[A3, 'accepted']]);
    });

    it('a co-organiser may not add or remove anyone but itself (403, nothing written)', async () => {
      await expect(update(A3, E(1), [A3, A4], 'coEd')).rejects.toBeInstanceOf(ForbiddenException);
      expect(await proposalRows(E(1))).toHaveLength(1);
      expect(told).toEqual([]);
    });

    it('a co-organiser that LEAVES: rights and reach go, the event stays with its organiser', async () => {
      await update(A3, E(1), [], 'coEd');
      expect(await coOwnersOf(E(1))).toEqual([]);
      expect(await proposalRows(E(1))).toEqual([
        { toAssociationId: A3, status: 'withdrawn', decidedBy: 'coEd' },
      ]);
      expect(await associations.findCalendarEventForAssociation(E(1), A3, false)).toBeNull();
      expect(await agendaOf('gaReader')).toEqual([]);
      expect(await agendaOf('seReader')).toContain(E(1));
      // The pair may be asked again: a withdrawn proposal frees its place.
      await update(A1, E(1), [A3], 'org');
      expect((await proposalRows(E(1))).map((r) => r.status)).toEqual(['withdrawn', 'pending']);
    });
  });

  describe('refusal and withdrawal', () => {
    it('a refusal is recorded, adds no reach, and the same pair is not asked again', async () => {
      await update(A1, E(2), [A3], 'org');
      const proposal = (await proposals.listPending(A3, 'coPub', false)).incoming.find(
        (p) => p.subjectId === E(2)
      );
      await proposals.refuse(proposal!.id, 'coPub', false);
      expect(await proposalRows(E(2))).toEqual([
        { toAssociationId: A3, status: 'refused', decidedBy: 'coPub' },
      ]);
      expect(await agendaOf('gaReader')).not.toContain(E(2));
      told.length = 0;
      await update(A1, E(2), [A3], 'org');
      expect(await proposalRows(E(2))).toHaveLength(1);
      expect(told).toEqual([]);
      await expect(proposals.propose('coorganise', E(2), A3, 'org', false)).rejects.toBeInstanceOf(
        ConflictException
      );
      const states = await coorg.listStatesFor(A1, E(2), 'org', false);
      expect(states.map((s) => [s.associationId, s.status])).toEqual([[A3, 'refused']]);
    });

    it('the organiser withdraws a pending one by the form, or by the queue; the receiver cannot', async () => {
      await update(A1, E(3), [A3, A4], 'org');
      await update(A1, E(3), [A4], 'org');
      expect(await proposalRows(E(3))).toEqual([
        { toAssociationId: A3, status: 'withdrawn', decidedBy: 'org' },
        { toAssociationId: A4, status: 'pending', decidedBy: null },
      ]);
      const outgoing = (await proposals.listPending(A1, 'org', false)).outgoing.find(
        (p) => p.subjectId === E(3)
      );
      await expect(proposals.withdraw(outgoing!.id, 'coPub', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      await proposals.withdraw(outgoing!.id, 'org', false);
      expect((await proposalRows(E(3))).map((r) => r.status)).toEqual(['withdrawn', 'withdrawn']);
    });

    it('the organiser removes an accepted co-organiser: its rights go', async () => {
      await update(A1, E(0), [], 'org');
      expect(await coOwnersOf(E(0))).toEqual([]);
      expect(await associations.findCalendarEventForAssociation(E(0), A2, false)).toBeNull();
      expect(await proposalRows(E(0))).toEqual([
        { toAssociationId: A2, status: 'withdrawn', decidedBy: 'org' },
      ]);
    });
  });

  describe('permissions and cleanup', () => {
    it('a reader with no right on the event cannot read its co-organisers (403)', async () => {
      await expect(coorg.listStatesFor(A1, E(1), 'gaReader', false)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('the organiser itself is never a co-organiser', async () => {
      await update(A1, E(4), [A1], 'org');
      expect(await proposalRows(E(4))).toEqual([]);
    });

    it('deleting an event removes its co-organisers and its proposals (074 trigger)', async () => {
      await update(A1, E(5), [A3], 'org');
      const [p] = (await proposals.listPending(A3, 'coPub', false)).incoming.filter(
        (x) => x.subjectId === E(5)
      );
      await proposals.accept(p.id, 'coPub', false);
      expect(await coOwnersOf(E(5))).toEqual([A3]);
      await q(`DELETE FROM association_calendar_events WHERE id = $1`, [E(5)]);
      expect(await coOwnersOf(E(5))).toEqual([]);
      expect(await proposalRows(E(5))).toEqual([]);
    });
  });

  describe('a decision and an association delete share one lock order', () => {
    const A5 = '00000000-0000-4000-8000-0000000c0a05'; // deleted below

    /**
     * The pid of a backend, not in `known`, waiting on a lock one of `holders` holds. Polled until
     * the lock graph shows it, never timed: no verdict rests on a duration.
     */
    async function nextWaiterOn(holders: number[], known: number[] = []): Promise<number> {
      for (let i = 0; i < 5000; i++) {
        const rows: { pid: number }[] = await q(
          `SELECT pid FROM pg_stat_activity
            WHERE pg_blocking_pids(pid) && $1::int[] AND NOT (pid = ANY($2::int[]))`,
          [holders, known]
        );
        if (rows.length > 0) return rows[0].pid;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`nothing came to wait on ${holders.join(',')}`);
    }

    it('a co-organisation decision and the organiser`s delete both complete (no 40P01)', async () => {
      await q(
        `INSERT INTO associations (id, name, slug, "createdBy") VALUES ($1, 'Doomed', 'doomed', 'it')`,
        [A5]
      );
      await q(
        `INSERT INTO association_members ("associationId", "userId", role, permissions) VALUES ($1, 'org', 'admin', $2)`,
        [A5, PROPOSE]
      );
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, 'Doomed event', '2026-07-01T18:00:00Z', 'org', 'validated')`,
        [E(10), A5]
      );
      await update(A5, E(10), [A3], 'org');
      const [p] = (await proposals.listPending(A3, 'coPub', false)).incoming.filter(
        (x) => x.subjectId === E(10)
      );
      // A holder of the proposal lines both writers up behind it: the decision first, holding the
      // associations' KEY SHARE; then the delete.
      const hold = ds.createQueryRunner();
      await hold.connect();
      let eventFree: boolean;
      let deciding: Promise<{ value?: unknown; error?: unknown }> | undefined;
      let removing: Promise<{ value?: unknown; error?: unknown }> | undefined;
      try {
        await hold.startTransaction();
        await hold.query(`SELECT 1 FROM proposals WHERE id = $1 FOR UPDATE`, [p.id]);
        const [{ pid: holder }]: { pid: number }[] = await hold.query(
          `SELECT pg_backend_pid() AS pid`
        );
        deciding = proposals.accept(p.id, 'coPub', false).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        const decider = await nextWaiterOn([holder]);
        removing = associations.remove(A5, 'org').then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        await nextWaiterOn([holder, decider], [decider]);
        // The delete waits holding NOTHING: locking the association last, it had already deleted
        // the event (and, through 074's trigger, reached for the proposal) - the half of the cycle
        // the decision closed by waiting on the association.
        eventFree = await q(
          `SELECT 1 FROM association_calendar_events WHERE id = $1 FOR UPDATE NOWAIT`,
          [E(10)]
        ).then(
          () => true,
          () => false
        );
      } finally {
        if (hold.isTransactionActive) await hold.rollbackTransaction();
        await hold.release();
      }
      expect(eventFree).toBe(true);
      expect(await deciding).toMatchObject({ value: { status: 'accepted' } });
      expect(await removing).toEqual({ value: { ok: true } });
      expect(await q(`SELECT 1 FROM associations WHERE id = $1`, [A5])).toEqual([]);
      expect(await proposalRows(E(10))).toEqual([]);
      expect(await coOwnersOf(E(10))).toEqual([]);
    }, 30_000);

    it('an account erasure and the delete of an association it created and belongs to both complete', async () => {
      const A6 = '00000000-0000-4000-8000-0000000c0a06';
      const GONE = 'erasee';
      await q(
        `INSERT INTO associations (id, name, slug, "createdBy") VALUES ($1, 'Founded', 'founded', $2)`,
        [A6, GONE]
      );
      await q(
        `INSERT INTO association_members ("associationId", "userId", role, permissions)
           VALUES ($1, $2, 'admin', 0), ($1, 'org', 'admin', $3)`,
        [A6, GONE, PROPOSE]
      );
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, 'Founded event', '2026-07-02T18:00:00Z', 'org', 'validated')`,
        [E(11), A6]
      );
      // The erasure runs its statements on the tables this schema has in full; the others (and the
      // partial ones built above for the lock and the delete) are not what this case is about.
      const partial = new Set([
        'users',
        'posts',
        'booking_spaces',
        'booking_resources',
        'bookings',
        'booking_participants',
        'booking_blocks',
        'booking_files',
        'association_role_history',
        'association_push_mutes',
        'form_respondents',
      ]);
      const present = new Set(
        (
          (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [
            schema,
          ])) as { table_name: string }[]
        ).map((r) => r.table_name)
      );
      const skipped = (sql: string) => {
        const table = /(?:FROM|UPDATE)\s+([a-z_]+)/.exec(sql)?.[1];
        return !!table && (!present.has(table) || partial.has(table));
      };
      // A holder of the erased account's member row lines both up: the erasure first, then the delete.
      const hold = ds.createQueryRunner();
      const erase = ds.createQueryRunner();
      await hold.connect();
      await erase.connect();
      let eventFree: boolean;
      let erasing: Promise<{ value?: unknown; error?: unknown }> | undefined;
      let removing: Promise<{ value?: unknown; error?: unknown }> | undefined;
      try {
        await hold.startTransaction();
        await hold.query(
          `SELECT 1 FROM association_members WHERE "associationId" = $1 AND "userId" = $2 FOR UPDATE`,
          [A6, GONE]
        );
        const [{ pid: holder }]: { pid: number }[] = await hold.query(
          `SELECT pg_backend_pid() AS pid`
        );
        const [{ pid: eraser }]: { pid: number }[] = await erase.query(
          `SELECT pg_backend_pid() AS pid`
        );
        await erase.startTransaction();
        const db: ErasureDb = {
          write: async (sql, params) =>
            skipped(sql) ? 0 : ((await erase.query(sql, params)) as [unknown, number])[1],
          read: async <T>(sql: string, params: unknown[]) =>
            skipped(sql) ? [] : ((await erase.query(sql, params)) as T[]),
        };
        erasing = eraseSocialRows(db, GONE).then(
          async (value) => {
            await erase.commitTransaction();
            return { value };
          },
          async (error: unknown) => {
            await erase.rollbackTransaction();
            return { error };
          }
        );
        expect(await nextWaiterOn([holder])).toBe(eraser);
        removing = associations.remove(A6, 'org').then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        await nextWaiterOn([holder, eraser], [eraser]);
        // The delete waits holding NOTHING. Taking the association last, the erasure let it lock
        // the association and delete the event, then wait on the member row; the erasure then
        // waited on the association (`UPDATE associations SET "createdBy"`): 40P01.
        eventFree = await q(
          `SELECT 1 FROM association_calendar_events WHERE id = $1 FOR UPDATE NOWAIT`,
          [E(11)]
        ).then(
          () => true,
          () => false
        );
      } finally {
        if (hold.isTransactionActive) await hold.rollbackTransaction();
        await hold.release();
      }
      expect(eventFree).toBe(true);
      expect(await erasing).toMatchObject({ value: { counts: { associations_locked: 1 } } });
      await erase.release();
      expect(await removing).toEqual({ value: { ok: true } });
      expect(await q(`SELECT 1 FROM associations WHERE id = $1`, [A6])).toEqual([]);
      expect(await q(`SELECT 1 FROM association_members WHERE "userId" = $1`, [GONE])).toEqual([]);
    }, 30_000);
  });

  describe('partner rights (E2, WP-Q1): the text and the poster belong to a partner, the rest to the organiser', () => {
    const P = E(20); // refusals, then the allowed edits
    const W = E(21); // the partner withdraws
    const D = E(22); // pending: the rights above the partner are unchanged
    const PARTNER_ONLY = { response: { code: 'CALENDAR_PARTNER_ORGANISER_ONLY' } };

    /** The event as stored, the columns an edit could have touched. */
    async function stored(id: string) {
      const [row] = (await q(
        `SELECT title, description, "startsAt", "endsAt", status FROM association_calendar_events WHERE id = $1`,
        [id]
      )) as {
        title: string;
        description: string | null;
        startsAt: Date;
        endsAt: Date | null;
        status: string;
      }[];
      return row;
    }

    beforeAll(async () => {
      for (const [id, status] of [
        [P, 'validated'],
        [W, 'validated'],
        [D, 'pending'],
      ]) {
        await q(
          `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
             VALUES ($1, $2, $3, '2026-07-01T18:00:00Z', 'org', $4)`,
          [id, A1, `Partner event ${id.slice(-3)}`, status]
        );
        await update(A1, id, [A3], 'org');
        const pending = (await proposals.listPending(A3, 'coPub', false)).incoming.find(
          (x) => x.subjectId === id
        );
        await proposals.accept(pending!.id, 'coPub', false);
      }
    });

    it('assertMayWriteEvent names the side: the organiser, a partner, and a platform admin above both', async () => {
      await expect(associations.assertMayWriteEvent('org', false, A1, P)).resolves.toMatchObject({
        side: 'organiser',
      });
      await expect(associations.assertMayWriteEvent('coEd', false, A3, P)).resolves.toMatchObject({
        side: 'partner',
      });
      // A platform admin keeps the organiser's rights through ANY route, the partner's included.
      await expect(associations.assertMayWriteEvent('root', true, A3, P)).resolves.toMatchObject({
        side: 'organiser',
        isGlobalAdmin: true,
      });
      // The poster routes ask this same rule: a partner passes it.
      await expect(associations.assertMayWriteEvent('nobody', false, A3, P)).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('the write-side route answers from that rule, and 404s an unreachable event', async () => {
      await expect(coorg.writeSideFor(A3, P, 'coEd', false)).resolves.toEqual({ side: 'partner' });
      await expect(coorg.writeSideFor(A1, P, 'org', false)).resolves.toEqual({ side: 'organiser' });
      await expect(coorg.writeSideFor(A3, E(2), 'coEd', false)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('REFUSAL 1 and 2: a partner moving the start or the end gets the typed 403, nothing written', async () => {
      const before = await stored(P);
      await expect(
        associations.updateCalendarEvent(
          A3,
          P,
          { startsAt: '2026-07-02T18:00:00.000Z' },
          { callerUserId: 'coEd' }
        )
      ).rejects.toMatchObject(PARTNER_ONLY);
      await expect(
        associations.updateCalendarEvent(
          A3,
          P,
          { endsAt: '2026-07-01T20:00:00.000Z' },
          { callerUserId: 'coEd' }
        )
      ).rejects.toMatchObject(PARTNER_ONLY);
      expect(await stored(P)).toEqual(before);
      expect(told).toEqual([]);
    });

    it('REFUSAL 3: a partner adding or removing another partner gets the typed 403, nothing written', async () => {
      const proposalsBefore = await proposalRows(P);
      await expect(update(A3, P, [A3, A4], 'coEd')).rejects.toMatchObject(PARTNER_ONLY);
      expect(await proposalRows(P)).toEqual(proposalsBefore);
      expect(await coOwnersOf(P)).toEqual([A3]);
      expect(told).toEqual([]);
    });

    it('a refused partner-list change leaves NO partial write: the form link and the other event keep their state', async () => {
      const OTHER = E(23);
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, 'Linked elsewhere', '2026-07-05T18:00:00Z', 'org', 'validated')`,
        [OTHER, A3]
      );
      const form = await ds
        .getRepository(Form)
        .save(
          ds
            .getRepository(Form)
            .create({ title: 'Form', associationId: A3, ownerId: 'coEd' } as Partial<Form>)
        );
      await q(`UPDATE association_calendar_events SET "linkedFormId" = $2 WHERE id = $1`, [
        OTHER,
        form.id,
      ]);
      const link = async (id: string) =>
        (
          (await q(`SELECT "linkedFormId" FROM association_calendar_events WHERE id = $1`, [
            id,
          ])) as {
            linkedFormId: string | null;
          }[]
        )[0].linkedFormId;
      const proposalsBefore = await proposalRows(P);

      // A form link (which detaches the link of every OTHER event on that form) together with a
      // partner-list change a partner may not make: the refusal must come before the detach.
      await expect(
        associations.updateCalendarEvent(
          A3,
          P,
          { linkedFormId: form.id, coOwnerIds: [A3, A4] },
          { callerUserId: 'coEd' }
        )
      ).rejects.toMatchObject(PARTNER_ONLY);

      expect(await link(OTHER)).toBe(form.id);
      expect(await link(P)).toBeNull();
      expect(await proposalRows(P)).toEqual(proposalsBefore);
    });

    it('REFUSAL 4: a partner deleting the event gets the typed 403, and the event stays', async () => {
      await expect(
        associations.deleteCalendarEvent(A3, P, { callerUserId: 'coEd' })
      ).rejects.toMatchObject(PARTNER_ONLY);
      expect(await stored(P)).toBeDefined();
    });

    it('the TEXT belongs to a partner: title and description change, and a resubmitted date is no date change', async () => {
      const before = await stored(P);
      await associations.updateCalendarEvent(
        A3,
        P,
        {
          title: 'Retitled by the partner',
          description: 'A new text',
          // What both modals do: every rendered field is sent back. Unchanged is not a change.
          startsAt: new Date(before.startsAt).toISOString(),
        },
        { callerUserId: 'coEd' }
      );
      const after = await stored(P);
      expect(after.title).toBe('Retitled by the partner');
      expect(after.description).toBe('A new text');
      // And the edit did not re-open the validation: a title is not a date.
      expect(after.status).toBe('validated');
      expect(new Date(after.startsAt)).toEqual(new Date(before.startsAt));
    });

    it('the POSTER belongs to a partner: it sets and clears the poster through the service, the status untouched', async () => {
      // The media-service round trip is the one thing replaced; everything the service decides runs.
      const media = associations as unknown as Record<string, (...a: unknown[]) => unknown>;
      const upload = jest
        .spyOn(media, 'uploadLogoToMedia')
        .mockResolvedValue('media-partner' as never);
      const cleanup = jest
        .spyOn(media, 'deleteMediaBestEffort')
        .mockResolvedValue(undefined as never);
      try {
        const tier = await associations.assertMayWriteEvent('coEd', false, A3, P);
        expect(tier.side).toBe('partner');
        const posterOf = async () =>
          (
            (await q(
              `SELECT "imageMediaId", status FROM association_calendar_events WHERE id = $1`,
              [P]
            )) as { imageMediaId: string | null; status: string }[]
          )[0];

        await associations.setEventImageFromUpload(
          A3,
          P,
          { buffer: Buffer.from('png'), mimetype: 'image/png', size: 3 },
          'Bearer t',
          tier
        );
        expect(await posterOf()).toEqual({ imageMediaId: 'media-partner', status: 'validated' });

        await associations.clearEventImage(A3, P, 'Bearer t', tier);
        expect(await posterOf()).toEqual({ imageMediaId: null, status: 'validated' });
        expect(upload).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
      } finally {
        upload.mockRestore();
        cleanup.mockRestore();
      }
    });

    it('a partner may WITHDRAW: its rights and reach go, the event stays with its organiser', async () => {
      await update(A3, W, [], 'coEd');
      expect(await coOwnersOf(W)).toEqual([]);
      expect(await stored(W)).toBeDefined();
      expect(await associations.findCalendarEventForAssociation(W, A3, false)).toBeNull();
    });

    it('a platform admin and a governing validator keep their rights through the partner route', async () => {
      // A REAL governing validator: VALIDATE_EVENTS in the BDE of the space the organiser reaches
      // (A4 is made the BDE of ICM x saint-etienne, which A1's default audience reaches), so the
      // tier comes from mayValidateEvent and not from a hand-passed flag.
      await q(
        `UPDATE spaces SET "bdeAssociationId" = $1 WHERE formation = 'ICM' AND campus = 'saint-etienne'`,
        [A4]
      );
      await q(
        `INSERT INTO association_members ("associationId", "userId", role, permissions) VALUES ($1, 'bdeVal', 'admin', $2)`,
        [A4, AssociationPermissionFlag.VALIDATE_EVENTS]
      );
      try {
        await associations.updateCalendarEvent(
          A3,
          D,
          { startsAt: '2026-07-03T18:00:00.000Z' },
          { isGlobalAdmin: true }
        );
        const tier = await associations.assertMayWriteEvent('bdeVal', false, A3, D);
        expect(tier).toEqual({ isGlobalAdmin: false, isBde: true, side: 'organiser' });
        await associations.updateCalendarEvent(
          A3,
          D,
          { startsAt: '2026-07-04T18:00:00.000Z' },
          { isBde: tier.isBde, callerUserId: 'bdeVal' }
        );
        expect(new Date((await stored(D)).startsAt).toISOString()).toBe('2026-07-04T18:00:00.000Z');
        await associations.deleteCalendarEvent(A3, D, { isGlobalAdmin: true });
        expect(await q(`SELECT 1 FROM association_calendar_events WHERE id = $1`, [D])).toEqual([]);
      } finally {
        await q(`DELETE FROM association_members WHERE "userId" = 'bdeVal'`);
        await q(`UPDATE spaces SET "bdeAssociationId" = NULL WHERE "bdeAssociationId" = $1`, [A4]);
      }
    });

    it("the FORM LINK is the organiser's: a partner keeps the link through a text edit and cannot change it", async () => {
      const forms = ds.getRepository(Form);
      const organiserForm = await forms.save(
        forms.create({
          title: 'Organiser form',
          associationId: A1,
          ownerId: 'org',
        } as Partial<Form>)
      );
      const partnerForm = await forms.save(
        forms.create({ title: 'Partner form', associationId: A3, ownerId: 'coEd' } as Partial<Form>)
      );
      await q(`UPDATE association_calendar_events SET "linkedFormId" = $2 WHERE id = $1`, [
        P,
        organiserForm.id,
      ]);
      const link = async () =>
        (
          (await q(`SELECT "linkedFormId" FROM association_calendar_events WHERE id = $1`, [
            P,
          ])) as {
            linkedFormId: string | null;
          }[]
        )[0].linkedFormId;

      // A text edit, with and without the unchanged link resent: the pre-fix 400 ("Form must belong
      // to this association") broke exactly this, and the link survives it.
      await associations.updateCalendarEvent(
        A3,
        P,
        { title: 'Edited beside a linked form' },
        { callerUserId: 'coEd' }
      );
      await associations.updateCalendarEvent(
        A3,
        P,
        { title: 'Edited again', linkedFormId: organiserForm.id },
        { callerUserId: 'coEd' }
      );
      expect((await stored(P)).title).toBe('Edited again');
      expect(await link()).toBe(organiserForm.id);

      // Detaching it, and swapping it for its own form, are the organiser's: typed 403, link intact.
      for (const linkedFormId of [null, '', partnerForm.id]) {
        await expect(
          associations.updateCalendarEvent(
            A3,
            P,
            { title: 'Not saved', linkedFormId },
            { callerUserId: 'coEd' }
          )
        ).rejects.toMatchObject(PARTNER_ONLY);
      }
      expect(await link()).toBe(organiserForm.id);
      expect((await stored(P)).title).toBe('Edited again');
    });

    /**
     * Resolves once a statement of THIS suite's pool (never the polling connection) is WAITING on a
     * lock whose text matches `like`. No sleep: the loop ends on that observable condition, and it
     * FAILS, explicitly, when `settled` (the concurrent request) completes first - that would mean
     * it never waited, which is the very thing under test.
     */
    async function lockWaiter(like: string, settled: Promise<unknown>): Promise<void> {
      const done = settled.then(
        () => 'settled' as const,
        () => 'settled' as const
      );
      for (;;) {
        const waiting = (await q(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = $1
              AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $2`,
          [schema, like]
        )) as unknown[];
        if (waiting.length > 0) return;
        const next = await Promise.race([
          done,
          new Promise<'tick'>((resolve) => setImmediate(() => resolve('tick'))),
        ]);
        if (next === 'settled') {
          throw new Error('the concurrent request completed without waiting on the lock');
        }
      }
    }

    it('an edit and a validation of the same event are SERIALISED: the validation waits for the edit and keeps it', async () => {
      const I = E(24);
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, 'Before the edit', '2026-07-10T18:00:00Z', 'org', 'pending')`,
        [I, A1]
      );
      // The hook sits BETWEEN the edit's checks and its save and starts the concurrent validation.
      const hold: { validating?: Promise<unknown> } = {};
      const realCheck = coorg.check.bind(coorg);
      const check = jest.spyOn(coorg, 'check').mockImplementation(async (request, manager) => {
        await realCheck(request, manager);
        hold.validating = associations.validateCalendarEvent(A1, I, 'validator');
        await lockWaiter('%FOR NO KEY UPDATE%', hold.validating);
      });
      try {
        await associations.updateCalendarEvent(
          A1,
          I,
          { title: 'After the edit', coOwnerIds: [] },
          { callerUserId: 'org' }
        );
      } finally {
        check.mockRestore();
        // On EVERY path: a validation left running would write into the next test's world.
        await hold.validating?.catch(() => undefined);
      }
      await hold.validating;
      const [row] = (await q(
        `SELECT title, status, "validatedBy" FROM association_calendar_events WHERE id = $1`,
        [I]
      )) as { title: string; status: string; validatedBy: string | null }[];
      // Both writes survive, in order: the edit's title AND the validation's status.
      expect(row).toEqual({
        title: 'After the edit',
        status: 'validated',
        validatedBy: 'validator',
      });
    }, 30_000);

    it('an edit naming a partner and the DELETE of its organiser cannot hang each other: associations come first', async () => {
      const O9 = '00000000-0000-4000-8000-0000000a0009';
      const X = E(25);
      await q(
        `INSERT INTO associations (id, name, slug, "createdBy") VALUES ($1, 'Doomed', 'doomed', 'it')`,
        [O9]
      );
      await q(
        `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
           VALUES ($1, $2, 'Doomed event', '2026-07-12T18:00:00Z', 'org', 'pending')`,
        [X, O9]
      );
      // The delete (AssociationsService.remove): the association FOR UPDATE first, its events after.
      const deleter = new Client({
        connectionString: URL,
        options: `-c search_path=${schema},public`,
      });
      await deleter.connect();
      try {
        await deleter.query('BEGIN');
        await deleter.query('SELECT 1 FROM associations WHERE id = $1 FOR UPDATE', [O9]);
        const editing = associations
          .updateCalendarEvent(
            O9,
            X,
            { title: 'Late edit', coOwnerIds: [A3] },
            { callerUserId: 'u' }
          )
          .then(
            () => 'edited' as const,
            (err: unknown) => err
          );
        // The edit waits on the ASSOCIATION, holding nothing: the delete then goes on to the events.
        await lockWaiter('%FOR KEY SHARE%', editing);
        await deleter.query('DELETE FROM association_calendar_events WHERE "associationId" = $1', [
          O9,
        ]);
        await deleter.query('DELETE FROM associations WHERE id = $1', [O9]);
        await deleter.query('COMMIT');
        // Both complete, the edit typed: it never hangs behind a delete that waits on its event.
        expect(await editing).toBeInstanceOf(NotFoundException);
      } finally {
        await deleter.query('ROLLBACK').catch(() => undefined);
        await deleter.end();
      }
    }, 30_000);

    it('a failing k-th proposal rolls the WHOLE edit back: fields, form detach, ended partner, earlier proposals', async () => {
      const Y = E(26);
      const Z = E(27);
      for (const [id, title] of [
        [Y, 'Before'],
        [Z, 'Linked elsewhere'],
      ]) {
        await q(
          `INSERT INTO association_calendar_events (id, "associationId", title, "startsAt", "createdBy", status)
             VALUES ($1, $2, $3, '2026-07-14T18:00:00Z', 'org', 'pending')`,
          [id, A1, title]
        );
      }
      const forms = ds.getRepository(Form);
      const form = await forms.save(
        forms.create({ title: 'Rollback form', associationId: A1, ownerId: 'org' } as Partial<Form>)
      );
      await q(`UPDATE association_calendar_events SET "linkedFormId" = $2 WHERE id = $1`, [
        Z,
        form.id,
      ]);
      // Y has an ACCEPTED partner (A3), which the edit below would end.
      await update(A1, Y, [A3], 'org');
      const pending = (await proposals.listPending(A3, 'coPub', false)).incoming.find(
        (x) => x.subjectId === Y
      );
      await proposals.accept(pending!.id, 'coPub', false);
      const proposalsBefore = await proposalRows(Y);
      const toldBefore = told.length;
      const linkOf = async (id: string) =>
        (
          (await q(`SELECT "linkedFormId" FROM association_calendar_events WHERE id = $1`, [
            id,
          ])) as {
            linkedFormId: string | null;
          }[]
        )[0].linkedFormId;

      const real = proposals.proposeWithin.bind(proposals);
      let calls = 0;
      const spy = jest
        .spyOn(proposals, 'proposeWithin')
        .mockImplementation(async (...args: Parameters<typeof proposals.proposeWithin>) => {
          calls += 1;
          if (calls === 2) throw new Error('boom at the second proposal');
          return real(...args);
        });
      try {
        // Ends A3, proposes A2 (stored, inside the transaction), then A4 fails.
        await expect(
          associations.updateCalendarEvent(
            A1,
            Y,
            { title: 'Changed', linkedFormId: form.id, coOwnerIds: [A2, A4] },
            { callerUserId: 'org' }
          )
        ).rejects.toThrow('boom at the second proposal');
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBe(2);
      expect((await stored(Y)).title).toBe('Before');
      expect(await linkOf(Z)).toBe(form.id);
      expect(await linkOf(Y)).toBeNull();
      expect(await coOwnersOf(Y)).toEqual([A3]);
      expect(await proposalRows(Y)).toEqual(proposalsBefore);
      // Nobody was told about a proposal that was never committed.
      expect(told.length).toBe(toldBefore);
    });
  });
});

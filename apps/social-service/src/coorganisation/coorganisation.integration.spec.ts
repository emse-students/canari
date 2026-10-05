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
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files:
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
import type { PostNotificationsService } from '../posts/post-notifications.service';
import { Proposal } from '../proposals/proposal.entity';
import { ProposalsService } from '../proposals/proposals.service';
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
      ],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
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
    associations = new AssociationsService(
      ds.getRepository(Association),
      ds.getRepository(AssociationMember),
      ds.getRepository(AssociationCalendarEvent),
      ds.getRepository(AssociationCalendarEventCoOwner),
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      notifications,
      none
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
});

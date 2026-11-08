/**
 * A POST'S AGENDA LINK AND THE NEUTRAL SWITCH EXCLUDE EACH OTHER, AGAINST A REAL POSTGRESQL.
 *
 * The unit spec (`posts.service.calendar-link-lock.spec.ts`) proves the link is resolved with the
 * post write's transaction; only a database shows that the two row locks conflict - the post write
 * reads the event `FOR SHARE` (`PostsService.saveWithEventLink`), the switch holds it
 * `FOR NO KEY UPDATE` (`AssociationsService.withEventLock`) - so the second comer WAITS for the
 * first one's commit, reads it, and is refused `CALENDAR_NEUTRAL_LINKED_POST`. Both orders are run.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; locally, against a throwaway
 * PostgreSQL:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- calendar-link-lock.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Post } from './entities/post.entity';
import { PostsService } from './posts.service';
import { AssociationsService } from '../associations/associations.service';
import {
  AssociationCalendarEvent,
  AssociationCalendarEventPresentation,
  AssociationCalendarEventStatus,
} from '../associations/entities/association-calendar-event.entity';
import { CALENDAR_NEUTRAL_ERROR_CODES } from '../associations/event-presentation';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const BDE = '00000000-0000-4000-8000-0000000000b1';

/** A promise and the function that settles it: a gate a transaction waits on, never a clock. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Settles a promise into a value or an error, so a test can await it after a commit. */
const settled = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ value, error: null as unknown }),
    (e: unknown) => ({ value: null as T | null, error: e })
  );

maybe(
  'a post link and the neutral switch are serialised by the event row lock (PostgreSQL)',
  () => {
    const schema = `event_link_it_${Math.random().toString(36).slice(2, 10)}`;
    let admin: Client;
    let ds: DataSource;
    let associations: AssociationsService;
    let posts: PostsService;

    beforeAll(async () => {
      for (const level of ['log', 'warn', 'debug'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
      }
      admin = new Client({ connectionString: URL });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema},public`);
      // The tables the switch's checks read (`keyShareAssociations`, `assertEventPresentationAfterUpdate`).
      await admin.query(`CREATE TABLE associations (id uuid PRIMARY KEY)`);
      await admin.query(`CREATE TABLE spaces ("bdeAssociationId" uuid)`);
      await admin.query(
        `CREATE TABLE association_calendar_event_co_owners (event_id uuid, association_id uuid)`
      );
      await admin.query(`CREATE TABLE proposals (kind varchar, "subjectId" uuid, status varchar)`);
      await admin.query(`INSERT INTO associations (id) VALUES ($1)`, [BDE]);
      await admin.query(`INSERT INTO spaces ("bdeAssociationId") VALUES ($1)`, [BDE]);
      ds = new DataSource({
        type: 'postgres',
        url: URL,
        entities: [AssociationCalendarEvent, Post],
        synchronize: true,
        uuidExtension: 'pgcrypto',
        installExtensions: false,
        // Named after the schema, so `waitersReach` counts only THIS run's sessions.
        extra: { options: `-c search_path=${schema},public`, application_name: schema },
      });
      await ds.initialize();
      associations = Object.assign(Object.create(AssociationsService.prototype) as object, {
        logger: new Logger('AssociationsService'),
        calendarRepo: ds.getRepository(AssociationCalendarEvent),
      }) as unknown as AssociationsService;
      posts = Object.assign(Object.create(PostsService.prototype) as object, {
        logger: new Logger('PostsService'),
        postRepo: ds.getRepository(Post),
        associationsService: associations,
      }) as unknown as PostsService;
    });

    afterAll(async () => {
      await ds?.destroy();
      await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin?.end();
      jest.restoreAllMocks();
    });

    /** A fresh validated event of the BDE, presented in its name. */
    async function event(): Promise<string> {
      const repo = ds.getRepository(AssociationCalendarEvent);
      const saved = await repo.save(
        repo.create({
          associationId: BDE,
          title: 'Soiree',
          startsAt: new Date('2026-11-20T19:00:00Z'),
          createdBy: 'bde-secretary',
          status: AssociationCalendarEventStatus.Validated,
          presentation: AssociationCalendarEventPresentation.Association,
        })
      );
      return saved.id;
    }

    /** The switch to neutral, as `updateCalendarEvent` runs it, holding the lock until `hold` opens. */
    function switchToNeutral(eventId: string, hold: Promise<void>, held: () => void) {
      return associations.withEventLock(eventId, async (repo, manager) => {
        held();
        await hold;
        const ev = await repo.findOneOrFail({ where: { id: eventId } });
        await (
          associations as unknown as {
            assertEventPresentationAfterUpdate: (...args: unknown[]) => Promise<void>;
          }
        ).assertEventPresentationAfterUpdate(
          manager,
          ev,
          { presentation: AssociationCalendarEventPresentation.Neutral },
          BDE,
          'organiser'
        );
        return repo.save(ev);
      });
    }

    /** A post linking `eventId`, written as `createPost` writes it, holding its transaction on `hold`. */
    function linkPost(eventId: string, hold: Promise<void>, held: () => void) {
      const post = ds.getRepository(Post).create({
        authorId: 'bde-secretary',
        markdown: 'Soiree',
        associationId: BDE,
        linkedCalendarEventId: eventId,
      });
      return (
        posts as unknown as {
          saveWithEventLink: (
            p: Post,
            linking: boolean,
            write: (repo: { save: (p: Post) => Promise<Post> }) => Promise<Post>
          ) => Promise<Post>;
        }
      ).saveWithEventLink(post, true, async (repo) => {
        const saved = await repo.save(post);
        held();
        await hold;
        return saved;
      });
    }

    /**
     * Reads `pg_locks` until one of THIS run's pool sessions waits on a lock, or a bounded number of
     * reads has gone by; answers whether it did. A read loop, never a clock.
     */
    async function aSessionWaits(): Promise<boolean> {
      for (let i = 0; i < 10_000; i++) {
        await admin.query('SELECT pg_stat_clear_snapshot()');
        const { rows } = await admin.query(
          `SELECT count(*)::int AS n FROM pg_locks l
          WHERE NOT l.granted
            AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE application_name = $1)`,
          [schema]
        );
        if ((rows[0] as { n: number }).n > 0) return true;
      }
      return false;
    }

    const linkedPosts = async (eventId: string) =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM posts WHERE "linkedCalendarEventId" = $1`,
          [eventId]
        )
      ).rows[0].n as number;

    const presentationOf = async (eventId: string) =>
      (
        await admin.query(`SELECT presentation FROM association_calendar_events WHERE id = $1`, [
          eventId,
        ])
      ).rows[0].presentation as string;

    it('the switch first: the post write WAITS, then reads the neutral row and is refused', async () => {
      const eventId = await event();
      const hold = gate();
      const held = gate();
      const switching = settled(switchToNeutral(eventId, hold.wait, held.open));
      await held.wait;
      const linking = settled(linkPost(eventId, Promise.resolve(), () => undefined));
      expect(await aSessionWaits()).toBe(true);
      hold.open();

      expect((await switching).error).toBeNull();
      const refused = await linking;
      expect(refused.error).toMatchObject({
        response: { code: CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST },
      });
      expect(await linkedPosts(eventId)).toBe(0);
      expect(await presentationOf(eventId)).toBe(AssociationCalendarEventPresentation.Neutral);
    });

    it('the link first: the switch WAITS, then sees the committed post and is refused', async () => {
      const eventId = await event();
      const hold = gate();
      const held = gate();
      const linking = settled(linkPost(eventId, hold.wait, held.open));
      await held.wait;
      const switching = settled(switchToNeutral(eventId, Promise.resolve(), () => undefined));
      expect(await aSessionWaits()).toBe(true);
      hold.open();

      expect((await linking).error).toBeNull();
      const refused = await switching;
      expect(refused.error).toMatchObject({
        response: { code: CALENDAR_NEUTRAL_ERROR_CODES.LINKED_POST },
      });
      expect(await linkedPosts(eventId)).toBe(1);
      expect(await presentationOf(eventId)).toBe(AssociationCalendarEventPresentation.Association);
    });
  }
);

/**
 * WP-B6 AGAINST A REAL POSTGRESQL: a booking's FILE answers, the retention purge, the platform
 * maximum age, the poster's lifetime and the XLSX export (docs/wiki/bookings-chantier.md).
 *
 * The services run on a real connection with every bookings migration applied (092 included) to a
 * throwaway schema. The MEDIA SERVICE is the one fake: an in-memory store that answers as
 * `FormFilesService` does (store, fetch, delete on the owner's name), so what is under test is what
 * the bookings side does with it - who may attach, read and delete what, and what the rows say.
 *
 * Time is never the wall clock: bookings are handed `NOW`, the purge is handed the instant it judges
 * at. The files' upload instant is the database's `now()`, so the purge is judged relative to it.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files (see `bookings.integration.spec.ts`).
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { Client } from 'pg';
import * as ExcelJS from 'exceljs';
import { BOOKING_ENTITIES } from './bookings.module';
import { BookingsService, type Actor } from './bookings.service';
import { BookingSlotsService } from './booking-slots.service';
import { BookingSpacesService } from './booking-spaces.service';
import { BOOKING_FILE_MAX_PENDING_PER_ACCOUNT, BookingFilesService } from './booking-files.service';
import { BookingRetentionScheduler } from './booking-retention.scheduler';
import type { BookingNotificationsService } from './booking-notifications.service';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import { BookingPosterMedia } from './booking-poster-media';
import { BookingSpace } from './entities/booking-space.entity';
import { BookingResource } from './entities/booking-resource.entity';
import { BookingAvailabilityRule } from './entities/booking-availability-rule.entity';
import { BookingAvailabilityException } from './entities/booking-availability-exception.entity';
import { BookingBlock } from './entities/booking-block.entity';
import { Booking } from './entities/booking.entity';
import { BookingParticipant } from './entities/booking-participant.entity';
import { BookingFile } from './entities/booking-file.entity';
import { Association } from '../associations/entities/association.entity';
import type { AssociationsService } from '../associations/associations.service';
import type { PricingFactsService } from '../pricing/pricing-facts.service';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import type { UserTagService } from '../users/user-tag.service';
import {
  FileBlobGoneError,
  FORM_FILE_MAX_PENDING,
  type FileBlobOutcome,
  type FormFilesService,
} from '../forms/form-files.service';
import {
  BOOKINGS_ERASURE_STATEMENTS,
  DELETED_ACCOUNT,
  runErasureStatements,
} from '../internal/account-erasure';
import type { BookingExportLabels } from './booking-export';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const MIGRATION_DIR = join(__dirname, '..', 'migrations');
const MIGRATION = readdirSync(MIGRATION_DIR)
  .filter((f) => /^\d+_booking/.test(f))
  .sort()
  .map((f) => readFileSync(join(MIGRATION_DIR, f), 'utf8'))
  .join('\n');

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const ORGA = 'e'.repeat(64);
const STRANGER = 'f'.repeat(64);

/** Sunday 2026-11-01 12:00 UTC; the spaces are in Europe/Paris unless said otherwise. */
const NOW = Date.parse('2026-11-01T12:00:00Z');
const as = (userId: string): Actor => ({ userId, isGlobalAdmin: false });
const DAY_MS = 86_400_000;

const PDF = Buffer.from('%PDF-1.4\n% a CV\n');
const pdf = (name = 'CV Alice.pdf') => ({ buffer: PDF, size: PDF.length, originalname: name });

const LABELS: BookingExportLabels = {
  date: 'Date',
  start: 'Début',
  end: 'Fin',
  resource: 'Ressource',
  holder: 'Titulaire',
  participants: 'Participants',
  status: 'Statut',
  cancelled: 'Annulée',
  file: 'Fichier',
  fileDeleted: 'Fichier supprimé',
};

async function refusal(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return err.getResponse() as Record<string, unknown>;
    throw err;
  }
  throw new Error('expected a refusal, the call succeeded');
}

maybe('bookings files, retention, poster and export against PostgreSQL (WP-B6)', () => {
  const schema = `bookings_b6_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: BookingsService;
  let organiser: BookingSpacesService;
  let retention: BookingRetentionScheduler;
  let files: BookingFilesService;
  let posterMedia: BookingPosterMedia;
  const grants = new Set<string>();
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  /** The media service: object id -> its owner and bytes. Deletion only on the owner's name. */
  const media = new Map<string, { owner: string; bytes: Buffer }>();
  /** What the media service was asked of a poster: `claim:<class>:<id>` and `<class>:<id>`. */
  const posterCalls: string[] = [];
  /**
   * Holds the media service's delete until the test opens it: the purge is then IN its delete, with
   * whatever it holds held - how a race is staged without a clock.
   */
  let purgeGate: { fileId: string; entered: () => void; open: Promise<void> } | null = null;
  /** The media service's images: owner, retention class, inside the claim window, claimed for. */
  const images = new Map<string, { owner: string; cls: string; fresh: boolean; space?: string }>();

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [...BOOKING_ENTITIES, Association],
      synchronize: false,
      extra: { options: `-c search_path=${schema}`, max: 8 },
    });
    await ds.initialize();
    await q(`CREATE TABLE associations (id uuid PRIMARY KEY)`);
    // The profile columns the campus predicate reads (`reader-spaces.ts`): every account here is an
    // ICM Saint-Etienne student, and every association reaches every space - the campus border is
    // `bookings.service.integration.spec.ts`'s subject, not this file's.
    await q(
      `CREATE TABLE users (id varchar PRIMARY KEY, "firstName" varchar, "lastName" varchar,
         admin boolean NOT NULL DEFAULT false, campus varchar DEFAULT 'saint-etienne',
         cursus jsonb NOT NULL DEFAULT '[{"formation": "ICM"}]')`
    );
    await q(`CREATE TABLE spaces (formation varchar NOT NULL, campus varchar NOT NULL)`);
    await q(`INSERT INTO spaces VALUES ('ICM', 'saint-etienne')`);
    await q(
      `CREATE TABLE association_audiences ("associationId" uuid NOT NULL, formation varchar, campus varchar)`
    );
    await q(
      `CREATE TABLE association_members ("associationId" uuid NOT NULL, "userId" varchar NOT NULL)`
    );
    await q(
      `CREATE TABLE user_blocks ("blockerId" varchar NOT NULL, "blockedId" varchar NOT NULL)`
    );
    await q(MIGRATION);
    // Applied twice, as a deploy may replay it.
    await q(MIGRATION);
    for (const [id, first] of [
      [ALICE, 'Alice'],
      [BOB, 'Bob'],
      [ORGA, 'Orga'],
      [STRANGER, 'Stranger'],
    ]) {
      await q(`INSERT INTO users (id, "firstName", "lastName") VALUES ($1, $2, 'X')`, [id, first]);
    }

    const associations = {
      mayAct: async (userId: string, associationId: string, flag: number) =>
        flag === AssociationPermissionFlag.MANAGE_BOOKINGS &&
        grants.has(`${userId}:${associationId}`),
    } as unknown as AssociationsService;
    const pricingFacts = { build: async () => ({}) } as unknown as PricingFactsService;
    const formFiles = {
      storeBlob: async (data: Buffer, owner: string) => {
        const mediaId = randomUUID();
        media.set(mediaId, { owner, bytes: data });
        return { mediaId, sizeBytes: data.length };
      },
      fetchBlob: async (id: string) => {
        const object = media.get(id);
        if (!object) throw new FileBlobGoneError(404);
        return object.bytes;
      },
      purgeBlobs: async (items: Array<{ mediaId: string; ownerId: string }>) => {
        if (purgeGate && items.some((i) => i.mediaId === purgeGate!.fileId)) {
          purgeGate.entered();
          await purgeGate.open;
        }
        const out: Record<string, FileBlobOutcome> = {};
        for (const { mediaId, ownerId } of items) {
          const object = media.get(mediaId);
          if (!object) out[mediaId] = 'absent';
          else if (object.owner !== ownerId) out[mediaId] = 'refused';
          else {
            media.delete(mediaId);
            out[mediaId] = 'deleted';
          }
        }
        return out;
      },
    } as unknown as FormFilesService;
    // The REAL poster lifetime, over a media service that answers as `claimPosters`,
    // `releasePosters` and `listPosters` do: a claim succeeds only on the caller's own fresh
    // `poster-pending` upload (or again, for the same space), a release moves a claimed poster alone.
    const CLAIMED = new Set(['poster', 'poster-association']);
    const mediaHttp = {
      post: (
        url: string,
        body: { mediaIds: string[]; ownerId?: string; spaceId?: string; retentionClass?: string }
      ) => {
        if (url.endsWith('media/internal/poster-claim')) {
          const claimed: string[] = [];
          const refused: string[] = [];
          for (const id of body.mediaIds) {
            const object = images.get(id);
            if (
              object?.owner === body.ownerId &&
              object.cls === body.retentionClass &&
              object.space === body.spaceId
            ) {
              claimed.push(id);
            } else if (
              object?.owner === body.ownerId &&
              object.cls === 'poster-pending' &&
              object.fresh
            ) {
              object.cls = body.retentionClass!;
              object.space = body.spaceId;
              claimed.push(id);
              posterCalls.push(`claim:${body.retentionClass}:${id}`);
            } else refused.push(id);
          }
          return of({ data: { claimed, refused } });
        }
        if (url.endsWith('media/internal/poster-release')) {
          const released: string[] = [];
          const refused: string[] = [];
          for (const id of body.mediaIds) {
            const object = images.get(id);
            if (object && CLAIMED.has(object.cls)) {
              object.cls = 'ephemeral';
              object.space = undefined;
              released.push(id);
              posterCalls.push(`release:${id}`);
            } else refused.push(id);
          }
          return of({ data: { released, refused } });
        }
        throw new Error(`unexpected media call ${url}`);
      },
      get: (url: string) => {
        if (!url.endsWith('media/internal/poster-list')) throw new Error(`unexpected ${url}`);
        const posters = [...images.entries()]
          .filter(([, o]) => CLAIMED.has(o.cls))
          .map(([mediaId, o]) => ({ mediaId, spaceId: o.space ?? null }));
        return of({ data: { posters } });
      },
    } as unknown as HttpService;
    posterMedia = new BookingPosterMedia(mediaHttp, ds.getRepository(BookingSpace));

    const repo = <T extends object>(e: new () => T) => ds.getRepository(e);
    const slots = new BookingSlotsService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(BookingAvailabilityRule),
      repo(BookingAvailabilityException),
      repo(BookingBlock),
      repo(Booking)
    );
    files = new BookingFilesService(repo(BookingFile), formFiles);
    // The notices (WP-N) have their own cases in `bookings.service.integration.spec.ts`.
    const silent = {
      added: async () => {},
      cancelled: async () => {},
      withdrawn: async () => {},
      spaceDeleted: async () => {},
    } as unknown as BookingNotificationsService;
    service = new BookingsService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(Booking),
      repo(BookingParticipant),
      repo(BookingBlock),
      slots,
      associations,
      pricingFacts,
      files,
      silent
    );
    organiser = new BookingSpacesService(
      repo(BookingSpace),
      repo(BookingResource),
      repo(BookingAvailabilityRule),
      repo(BookingAvailabilityException),
      repo(Booking),
      slots,
      associations,
      { listCotisationTiers: async () => [] } as unknown as UserTagService,
      posterMedia,
      silent
    );
    retention = new BookingRetentionScheduler(repo(BookingFile), formFiles);
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /**
   * An association space managed by ORGA, Europe/Paris, steps of 30 min, open 08:00-22:00 every day,
   * one resource, asking a CV (a FILE question, required) and a free text.
   */
  async function setup(settings: Partial<BookingSpace> = {}) {
    const association = (
      await q(
        `WITH a AS (INSERT INTO associations (id) VALUES (gen_random_uuid()) RETURNING id),
           r AS (INSERT INTO association_audiences ("associationId") SELECT id FROM a)
         SELECT id FROM a`
      )
    )[0].id as string;
    grants.add(`${ORGA}:${association}`);
    const space = await ds.getRepository(BookingSpace).save({
      ownerId: ORGA,
      associationId: association,
      name: 'Entretiens Alumni',
      timeZone: 'Europe/Paris',
      stepMinutes: 30,
      maxSteps: 2,
      retentionDays: 7,
      items: [
        { id: 'cv', label: 'CV', type: 'file', required: true },
        { id: 'year', label: 'Promo', type: 'text' },
      ],
      ...settings,
    });
    const resource = await ds
      .getRepository(BookingResource)
      .save({ spaceId: space.id, name: 'Alumni 1', position: 0 });
    for (let weekday = 1; weekday <= 7; weekday++) {
      await q(
        `INSERT INTO booking_availability_rules ("resourceId", weekday, "startTime", "endTime")
         VALUES ($1, $2, '08:00', '22:00')`,
        [resource.id, weekday]
      );
    }
    return { space, resourceId: resource.id };
  }

  /** Monday 2026-11-02, Paris time (UTC+1): `hh:mm` local. */
  const paris = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+01:00`).toISOString();

  const bookWith = (
    spaceId: string,
    resourceId: string,
    answers: Record<string, unknown>,
    from = '10:00',
    to = '10:30',
    actor = ALICE,
    extra: { holderId?: string } = {}
  ) =>
    service.book(
      spaceId,
      { resourceId, startsAt: paris(from), endsAt: paris(to), answers: answers as never, ...extra },
      as(actor),
      NOW
    );

  /** A second connection, to hold a transaction open while the code under test runs. */
  const raceClient = async () => {
    const client = new Client({ connectionString: URL, options: `-c search_path=${schema}` });
    await client.connect();
    return client;
  };

  /** The database's clock: the files' `createdAt` is written by it. */
  const dbNow = async () => new Date((await q(`SELECT now() AS n`))[0].n as string);

  describe('the file question (D7)', () => {
    it('stores a PDF for a file question, refuses any other question, type or an empty file', async () => {
      const { space } = await setup();
      expect(await refusal(service.uploadFile(space.id, 'year', pdf(), as(ALICE)))).toEqual({
        code: 'file-question',
      });
      const html = Buffer.from('<html>');
      expect(
        await refusal(
          service.uploadFile(space.id, 'cv', { buffer: html, size: html.length }, as(ALICE))
        )
      ).toEqual({ code: 'file-type' });
      expect(
        await refusal(
          service.uploadFile(space.id, 'cv', { buffer: Buffer.alloc(0), size: 0 }, as(ALICE))
        )
      ).toEqual({ code: 'file-empty' });

      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      expect(up).toEqual(
        expect.objectContaining({ fileName: 'CV Alice.pdf', contentType: 'application/pdf' })
      );
      const row = await ds.getRepository(BookingFile).findOneByOrFail({ id: up.fileId });
      expect([row.spaceId, row.itemId, row.uploaderId, row.bookingId]).toEqual([
        space.id,
        'cv',
        ALICE,
        null,
      ]);
    });

    it('caps unsent uploads per account across spaces, not only per space (review of #2045)', async () => {
      const spread = 'c'.repeat(64);
      await q(`INSERT INTO users (id, "firstName", "lastName") VALUES ($1, 'Spread', 'X')`, [
        spread,
      ]);
      const spaces = [];
      for (let i = 0; i < BOOKING_FILE_MAX_PENDING_PER_ACCOUNT / FORM_FILE_MAX_PENDING + 1; i++) {
        spaces.push((await setup()).space);
      }
      const [last] = spaces.splice(-1);
      for (const space of spaces) {
        for (let i = 0; i < FORM_FILE_MAX_PENDING; i++) {
          await service.uploadFile(space.id, 'cv', pdf(), as(spread));
        }
        expect(await refusal(service.uploadFile(space.id, 'cv', pdf(), as(spread)))).toEqual({
          code: 'files-pending',
        });
      }
      const before = media.size;
      expect(await refusal(service.uploadFile(last.id, 'cv', pdf(), as(spread)))).toEqual({
        code: 'files-pending-account',
      });
      // Refused before the bytes travel: nothing reached the store.
      expect(media.size).toBe(before);
    });

    it('refuses an upload to someone the audience does not admit', async () => {
      const { space } = await setup({ audience: { promo: { values: [2099] } } });
      expect(await refusal(service.uploadFile(space.id, 'cv', pdf(), as(ALICE)))).toEqual({
        code: 'audience',
      });
    });

    it("attaches the booker's own upload, and refuses another's - the booking rolled back", async () => {
      const { space, resourceId } = await setup();
      const bobs = await service.uploadFile(space.id, 'cv', pdf('bob.pdf'), as(BOB));
      expect(await refusal(bookWith(space.id, resourceId, { cv: bobs.fileId }))).toEqual({
        code: 'file-not-yours',
        itemId: 'cv',
      });
      expect(await ds.getRepository(Booking).count({ where: { resourceId } })).toBe(0);
      expect(await refusal(bookWith(space.id, resourceId, { cv: 'not-an-id' }))).toEqual({
        code: 'file-answer',
      });
      expect(await refusal(bookWith(space.id, resourceId, { year: '2027' }))).toEqual({
        code: 'answer-required',
        itemId: 'cv',
      });

      const mine = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      const { id } = await bookWith(space.id, resourceId, { cv: mine.fileId, year: '2027' });
      const row = await ds.getRepository(BookingFile).findOneByOrFail({ id: mine.fileId });
      expect(row.bookingId).toBe(id);
      // One file, one booking: a second booking cannot claim it again.
      expect(
        await refusal(bookWith(space.id, resourceId, { cv: mine.fileId }, '11:00', '11:30'))
      ).toEqual({ code: 'file-not-yours', itemId: 'cv' });
    });

    it('the organiser booking on behalf attaches the file THEY uploaded', async () => {
      const { space, resourceId } = await setup();
      const up = await service.uploadFile(space.id, 'cv', pdf('cv-bob.pdf'), as(ORGA));
      const { id } = await bookWith(
        space.id,
        resourceId,
        { cv: up.fileId },
        '10:00',
        '10:30',
        ORGA,
        {
          holderId: BOB,
        }
      );
      expect(
        (await ds.getRepository(BookingFile).findOneByOrFail({ id: up.fileId })).bookingId
      ).toBe(id);
    });

    it('names the file to the organiser alone, and serves its bytes to the organiser alone', async () => {
      const { space, resourceId } = await setup({ nameVisibility: 'names' });
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      const { id } = await bookWith(space.id, resourceId, { cv: up.fileId });

      const unitFor = async (who: string) =>
        (await service.spaceSlots(space.id, '2026-11-02', '2026-11-02', as(who)))[0].units.find(
          (u) => u.booking?.id === id
        )!.booking!;
      expect(await unitFor(ORGA)).toEqual(
        expect.objectContaining({ fileNames: { [up.fileId]: 'CV Alice.pdf' }, deletedFileIds: [] })
      );
      const other = await unitFor(BOB);
      expect([other.answers, other.fileNames]).toEqual([undefined, undefined]);
      const holder = await unitFor(ALICE);
      expect([holder.answers, holder.fileNames]).toEqual([undefined, undefined]);

      const page = await service.spaceBookings(space.id, as(ORGA));
      expect(page.items[0].fileNames).toEqual({ [up.fileId]: 'CV Alice.pdf' });

      const got = await service.downloadFile(id, up.fileId, as(ORGA));
      expect([got.data.equals(PDF), got.contentType, got.fileName]).toEqual([
        true,
        'application/pdf',
        'CV Alice.pdf',
      ]);
      // The holder is not the organiser: answers and files are the organiser's to read (D9).
      expect(await refusal(service.downloadFile(id, up.fileId, as(ALICE)))).toEqual({
        code: 'not-manager',
      });
      expect(await refusal(service.downloadFile(randomUUID(), up.fileId, as(STRANGER)))).toEqual({
        code: 'not-manager',
      });
      // Nor a global admin outside the organisers: a CV is not the platform's to read (D22, C17).
      expect(
        await refusal(
          service.downloadFile(id, up.fileId, { userId: STRANGER, isGlobalAdmin: true })
        )
      ).toEqual({ code: 'not-manager' });
      // A file of another booking is never served under this one.
      const other2 = await service.uploadFile(space.id, 'cv', pdf(), as(BOB));
      const { id: bobsBooking } = await bookWith(
        space.id,
        resourceId,
        { cv: other2.fileId },
        '12:00',
        '12:30',
        BOB
      );
      expect(bobsBooking).not.toBe(id);
      expect(await refusal(service.downloadFile(id, other2.fileId, as(ORGA)))).toEqual({
        code: 'file-not-found',
      });
    });

    it('a blob the media service no longer holds is marked purged and read "file deleted"', async () => {
      const { space, resourceId } = await setup();
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      const { id } = await bookWith(space.id, resourceId, { cv: up.fileId });
      media.delete(up.fileId);
      expect(await refusal(service.downloadFile(id, up.fileId, as(ORGA)))).toEqual({
        code: 'file-purged',
      });
      const page = await service.spaceBookings(space.id, as(ORGA));
      expect([page.items[0].fileNames, page.items[0].deletedFileIds]).toEqual([{}, [up.fileId]]);
    });
  });

  describe('the retention purge (D8, D18, D19, D41)', () => {
    it('takes the file and the answers N days after the SLOT ends, and a second run changes nothing', async () => {
      const { space, resourceId } = await setup({ retentionDays: 3 });
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      const { id } = await bookWith(space.id, resourceId, { cv: up.fileId, year: '2027' });
      const end = Date.parse(paris('10:30'));

      const early = await retention.purgeOnce(new Date(end + 3 * DAY_MS - 1));
      expect(early.files.due + early.answersPurged).toBe(0);
      expect(media.has(up.fileId)).toBe(true);

      const due = await retention.purgeOnce(new Date(end + 3 * DAY_MS));
      expect([due.files.due, due.files.gone, due.answersPurged]).toEqual([1, 1, 1]);
      expect(media.has(up.fileId)).toBe(false);
      const file = await ds.getRepository(BookingFile).findOneByOrFail({ id: up.fileId });
      expect(file.purgedAt).not.toBeNull();
      const booking = await ds.getRepository(Booking).findOneByOrFail({ id });
      expect([booking.answers, booking.answersPurgedAt?.getTime()]).toEqual([
        null,
        end + 3 * DAY_MS,
      ]);

      const again = await retention.purgeOnce(new Date(end + 3 * DAY_MS));
      expect([
        again.files.due,
        again.unsent.due,
        again.answersPurged,
        again.bookingsDeleted,
      ]).toEqual([0, 0, 0, 0]);
    });

    it('a file the store will not delete is KEPT, its row untouched, and retried next run', async () => {
      const { space, resourceId } = await setup({ retentionDays: 1 });
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      await bookWith(space.id, resourceId, { cv: up.fileId });
      // The store holds it under another owner: the allowlist refuses it.
      media.set(up.fileId, { owner: STRANGER, bytes: PDF });
      const at = new Date(Date.parse(paris('10:30')) + DAY_MS);
      const run = await retention.purgeOnce(at);
      expect([run.files.gone, run.kept, run.blobs.refused]).toEqual([0, 1, 1]);
      expect(
        (await ds.getRepository(BookingFile).findOneByOrFail({ id: up.fileId })).purgedAt
      ).toBe(null);
      media.set(up.fileId, { owner: ALICE, bytes: PDF });
      expect((await retention.purgeOnce(at)).files.gone).toBe(1);
    });

    it('an upload never sent goes after its day, blob and row', async () => {
      const { space } = await setup();
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      const created = await dbNow();
      expect(
        (await retention.purgeOnce(new Date(created.getTime() + DAY_MS - 60_000))).unsent.due
      ).toBe(0);
      const run = await retention.purgeOnce(new Date(created.getTime() + DAY_MS + 60_000));
      expect(run.unsent.gone).toBeGreaterThanOrEqual(1);
      expect(media.has(up.fileId)).toBe(false);
      expect(await ds.getRepository(BookingFile).findOneBy({ id: up.fileId })).toBeNull();
    });

    /**
     * A booking and the purge on ONE unsent file (review of #2045). `attach` judges the upload
     * window with its transaction's `NOW()`, so a booking that began inside the window may commit
     * after the purge judged the file unsent. Staged here with a second connection holding the
     * booking's transaction open, and the media service's delete held open by `purgeGate`.
     */
    const managerOf = (client: Client) =>
      ({
        query: async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows,
      }) as unknown as EntityManager;
    const optionalCv = async () => {
      const { space, resourceId } = await setup({
        items: [{ id: 'cv', label: 'CV', type: 'file' }],
      });
      const { id: bookingId } = await bookWith(space.id, resourceId, {});
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      return { space, bookingId, fileId: up.fileId };
    };

    it('a booking already citing an unsent file holds it: the purge skips it, the file stays cited', async () => {
      const { space, bookingId, fileId } = await optionalCv();
      const booking = await raceClient();
      try {
        await booking.query('BEGIN');
        await files.attach(managerOf(booking), bookingId, space.id, ALICE, [
          { itemId: 'cv', fileId },
        ]);
        // The purge judges after the window; the booking's transaction is still open.
        await retention.purgeOnce(new Date((await dbNow()).getTime() + 2 * DAY_MS));
        await booking.query('COMMIT');
      } finally {
        await booking.end();
      }
      expect(media.has(fileId)).toBe(true);
      const row = await ds.getRepository(BookingFile).findOneByOrFail({ id: fileId });
      expect([row.bookingId, row.purgedAt]).toEqual([bookingId, null]);
    });

    it('a booking reaching an unsent file the purge holds is refused: nothing cites a deleted blob', async () => {
      const { space, bookingId, fileId } = await optionalCv();
      let entered!: () => void;
      const inDelete = new Promise<void>((resolve) => (entered = resolve));
      let open!: () => void;
      purgeGate = { fileId, entered, open: new Promise<void>((resolve) => (open = resolve)) };
      const booking = await raceClient();
      try {
        const run = retention.purgeOnce(new Date((await dbNow()).getTime() + 2 * DAY_MS));
        await inDelete;
        await booking.query('BEGIN');
        const attaching = refusal(
          files.attach(managerOf(booking), bookingId, space.id, ALICE, [{ itemId: 'cv', fileId }])
        );
        open();
        await run;
        expect(await attaching).toEqual({ code: 'file-not-yours', itemId: 'cv' });
        await booking.query('ROLLBACK');
      } finally {
        purgeGate = null;
        await booking.end();
      }
      expect(media.has(fileId)).toBe(false);
      expect(await ds.getRepository(BookingFile).findOneBy({ id: fileId })).toBeNull();
    });

    it("a deleted space's files become orphans and go at the purge (D27)", async () => {
      const { space, resourceId } = await setup();
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      await bookWith(space.id, resourceId, { cv: up.fileId });
      await organiser.remove(space.id, as(ORGA), NOW);
      const row = await ds.getRepository(BookingFile).findOneByOrFail({ id: up.fileId });
      expect(row.bookingId).toBeNull();
      await retention.purgeOnce(new Date((await dbNow()).getTime() + 2 * DAY_MS));
      expect(media.has(up.fileId)).toBe(false);
      expect(await ds.getRepository(BookingFile).findOneBy({ id: up.fileId })).toBeNull();
    });

    it('deletes every booking and block that ENDED over a year ago, participants included (D19)', async () => {
      const { space, resourceId } = await setup({ items: [] });
      const { id } = await service.book(
        space.id,
        { resourceId, startsAt: paris('10:00'), endsAt: paris('10:30'), participantIds: [BOB] },
        as(ALICE),
        NOW
      );
      const { id: later } = await service.book(
        space.id,
        { resourceId, startsAt: paris('14:00'), endsAt: paris('14:30') },
        as(ALICE),
        NOW
      );
      await q(
        `INSERT INTO booking_blocks ("resourceId", "startsAt", "endsAt", "createdById")
         VALUES ($1, $2, $3, $4)`,
        [resourceId, paris('16:00'), paris('16:30'), ORGA]
      );
      const yearAfter = (hhmm: string) => new Date(paris(hhmm).replace('2026-11-02', '2027-11-02'));

      const before = await retention.purgeOnce(new Date(yearAfter('10:30').getTime() - 1));
      expect([before.bookingsDeleted, before.blocksDeleted]).toEqual([0, 0]);

      // The other tests' bookings share this day, so the counts are at least these two and this block.
      const run = await retention.purgeOnce(yearAfter('16:30'));
      expect(run.bookingsDeleted).toBeGreaterThanOrEqual(2);
      expect(run.blocksDeleted).toBeGreaterThanOrEqual(1);
      expect(await ds.getRepository(BookingBlock).countBy({ resourceId })).toBe(0);
      expect(await ds.getRepository(Booking).findBy({ id })).toEqual([]);
      expect(await ds.getRepository(Booking).findBy({ id: later })).toEqual([]);
      expect(await ds.getRepository(BookingParticipant).findBy({ bookingId: id })).toEqual([]);
      expect((await retention.purgeOnce(yearAfter('16:30'))).bookingsDeleted).toBe(0);
    });
  });

  describe('an account erased (C17)', () => {
    it('takes its files; the organiser reads "file deleted" where they were', async () => {
      const { space, resourceId } = await setup();
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(BOB));
      await bookWith(space.id, resourceId, { cv: up.fileId }, '10:00', '10:30', BOB);
      await ds.transaction((m) =>
        runErasureStatements(
          {
            write: async (sql, params) => ((await m.query(sql, params)) as [unknown, number])[1],
            read: async <T>(sql: string, params: unknown[]) => (await m.query(sql, params)) as T[],
          },
          BOOKINGS_ERASURE_STATEMENTS,
          BOB
        )
      );
      expect(await ds.getRepository(BookingFile).findOneBy({ id: up.fileId })).toBeNull();
      const page = await service.spaceBookings(space.id, as(ORGA));
      // The holder's answers are purged at the erasure (D18 early), so nothing cites the file.
      expect([page.items[0].answers, page.items[0].holderName]).toEqual([null, 'Bob X']);
      expect(
        (await ds.getRepository(Booking).findOneByOrFail({ id: page.items[0].id })).holderId
      ).toBe(DELETED_ACCOUNT);
    });
  });

  describe('the poster (D35)', () => {
    /** A poster citing a fresh `poster-pending` image uploaded by `owner`. */
    const poster = (owner: string, mediaId = randomUUID()) => {
      images.set(mediaId, { owner, cls: 'poster-pending', fresh: true });
      return {
        type: 'image' as const,
        mediaId,
        key: 'ab'.repeat(32),
        iv: 'cd'.repeat(12),
        mimeType: 'image/jpeg',
        size: 1234,
        width: 800,
        height: 600,
      };
    };
    const code = async (p: Promise<unknown>) => (await refusal(p)).code;
    const posterOfRow = async (id: string) =>
      (await ds.getRepository(BookingSpace).findOneByOrFail({ id })).poster;

    it("claims an entity space's poster as the entity's, releases the one replaced and a deleted space's", async () => {
      const { space } = await setup();
      const first = poster(ORGA);
      posterCalls.length = 0;
      await organiser.update(
        space.id,
        { poster: { ...first, forged: 'x' } as never },
        as(ORGA),
        NOW
      );
      expect(await posterOfRow(space.id)).toEqual(first);
      expect(posterCalls).toEqual([`claim:poster-association:${first.mediaId}`]);
      expect(images.get(first.mediaId)!.space).toBe(space.id);

      const second = poster(ORGA);
      await organiser.update(space.id, { poster: second }, as(ORGA), NOW);
      expect(posterCalls.slice(1)).toEqual([
        `claim:poster-association:${second.mediaId}`,
        `release:${first.mediaId}`,
      ]);
      // A save that does not touch the poster - or re-sends the same one - asks nothing.
      await organiser.update(space.id, { name: 'Renamed' }, as(ORGA), NOW);
      await organiser.update(space.id, { poster: second }, as(ORGA), NOW);
      expect(posterCalls).toHaveLength(3);

      expect((await service.getSpace(space.id, as(ALICE))).poster).toEqual(second);
      await organiser.remove(space.id, as(ORGA), NOW);
      expect(posterCalls.slice(3)).toEqual([`release:${second.mediaId}`]);
    });

    it("claims a person's poster as theirs, and removing it releases it", async () => {
      const mine = poster(ALICE);
      const { id } = await organiser.create({ name: 'Psy', poster: mine } as never, as(ALICE));
      expect(posterCalls[posterCalls.length - 1]).toBe(`claim:poster:${mine.mediaId}`);
      expect(images.get(mine.mediaId)!.space).toBe(id);
      await organiser.update(id, { poster: null }, as(ALICE), NOW);
      expect(posterCalls[posterCalls.length - 1]).toBe(`release:${mine.mediaId}`);
      expect(await posterOfRow(id)).toBeNull();
    });

    it("refuses another member's image, so removing it cannot hand it to the sweep (review of #2045)", async () => {
      const { space } = await setup();
      const bobs = poster(BOB);
      await expect(code(organiser.update(space.id, { poster: bobs }, as(ORGA), NOW))).resolves.toBe(
        'poster-not-yours'
      );
      await expect(
        code(organiser.create({ name: 'Mine', poster: bobs } as never, as(ALICE)))
      ).resolves.toBe('poster-not-yours');
      expect(await posterOfRow(space.id)).toBeNull();
      expect(images.get(bobs.mediaId)!.cls).toBe('poster-pending');
    });

    it("refuses the member's OWN post image or document, and a stale upload - only a poster upload qualifies", async () => {
      const { space } = await setup();
      const postImage = poster(ORGA);
      images.get(postImage.mediaId)!.cls = 'archive';
      const document = poster(ORGA);
      images.get(document.mediaId)!.cls = 'association';
      const old = poster(ORGA);
      images.get(old.mediaId)!.fresh = false;
      for (const p of [postImage, document, old]) {
        await expect(code(organiser.update(space.id, { poster: p }, as(ORGA), NOW))).resolves.toBe(
          'poster-not-yours'
        );
      }
      // Nothing the refused saves named was moved - least of all to the sweep.
      expect([postImage, document, old].map((p) => images.get(p.mediaId)!.cls)).toEqual([
        'archive',
        'association',
        'poster-pending',
      ]);
    });

    it('one poster, one space: a second space of the same member is refused it', async () => {
      const mine = poster(ALICE);
      const a = await organiser.create({ name: 'A', poster: mine } as never, as(ALICE));
      expect(await code(organiser.create({ name: 'B', poster: mine } as never, as(ALICE)))).toBe(
        'poster-not-yours'
      );
      expect(images.get(mine.mediaId)).toEqual(
        expect.objectContaining({ cls: 'poster', space: a.id })
      );
    });

    it('a claim whose save then fails is released, not kept', async () => {
      const mine = poster(ORGA);
      posterCalls.length = 0;
      // A global admin naming an entity that does not exist: claimed, then the row's key refuses.
      expect(
        await code(
          organiser.create({ name: 'Ghost', associationId: randomUUID(), poster: mine } as never, {
            userId: ORGA,
            isGlobalAdmin: true,
          })
        )
      ).toBe('association-not-found');
      expect(posterCalls).toEqual([
        `claim:poster-association:${mine.mediaId}`,
        `release:${mine.mediaId}`,
      ]);
    });

    it('a release waits for a claim in flight, then finds the poster cited (review of #2045)', async () => {
      const { space } = await setup();
      const mine = poster(ORGA);
      images.set(mine.mediaId, {
        owner: ORGA,
        cls: 'poster-association',
        fresh: true,
        space: space.id,
      });
      const writer = await raceClient();
      try {
        // A save between its claim and its commit: it holds the poster's lock and its row change.
        await writer.query('BEGIN');
        await writer.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `booking-poster:${mine.mediaId}`,
        ]);
        await writer.query(`UPDATE booking_spaces SET poster = $1 WHERE id = $2`, [
          JSON.stringify(mine),
          space.id,
        ]);
        let settled = false;
        const release = posterMedia
          .releaseUncited([mine.mediaId], 'raced')
          .finally(() => (settled = true));
        // The writer commits only once the release has either finished or is WAITING on the lock -
        // read from the server, never from a clock - so an unlocked release reads "uncited" first.
        for (;;) {
          const [{ n }] = (
            await admin.query(
              `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
            )
          ).rows as { n: number }[];
          if (n > 0 || settled) break;
        }
        await writer.query('COMMIT');
        await release;
      } finally {
        await writer.end();
      }
      expect(images.get(mine.mediaId)!.cls).toBe('poster-association');
    });

    it('the hourly reconciliation releases a claimed poster no space cites, and only that one', async () => {
      const { space } = await setup();
      const cited = poster(ORGA);
      await organiser.update(space.id, { poster: cited }, as(ORGA), NOW);
      // A save that died between its claim and its commit: claimed for a space that never existed.
      const orphan = randomUUID();
      images.set(orphan, { owner: ORGA, cls: 'poster', fresh: true, space: randomUUID() });
      posterCalls.length = 0;
      expect(await posterMedia.reconcileOnce()).toBeGreaterThanOrEqual(1);
      expect(posterCalls).toContain(`release:${orphan}`);
      expect(posterCalls).not.toContain(`release:${cited.mediaId}`);
      expect(await posterMedia.reconcileOnce()).toBe(0);
    });
  });

  describe('the export (D24)', () => {
    it('parses back: the words sent, the space clock, the cancelled, a file word, purged answers empty', async () => {
      const { space, resourceId } = await setup({ nameVisibility: 'names' });
      const up = await service.uploadFile(space.id, 'cv', pdf(), as(ALICE));
      const first = await bookWith(space.id, resourceId, { cv: up.fileId, year: '2027' });
      const bobsCv = await service.uploadFile(space.id, 'cv', pdf('bob.pdf'), as(BOB));
      const second = await bookWith(
        space.id,
        resourceId,
        { cv: bobsCv.fileId, year: '2026' },
        '21:30',
        '22:00',
        BOB
      );
      await service.cancel(second.id, as(BOB), NOW);
      // Bob's file is purged; his answers stay until the answers' own pass.
      await q(`UPDATE booking_files SET "purgedAt" = now() WHERE id = $1`, [bobsCv.fileId]);

      expect(await refusal(service.exportBookings(space.id, LABELS, as(ALICE)))).toEqual({
        code: 'not-manager',
      });
      const { buffer, name } = await service.exportBookings(space.id, LABELS, as(ORGA));
      expect(name).toBe('Entretiens Alumni');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as never);
      const rows = wb.worksheets[0]
        .getSheetValues()
        .slice(1)
        .map((r) => (r as unknown[]).slice(1));
      expect(rows).toEqual([
        ['Date', 'Début', 'Fin', 'Ressource', 'Titulaire', 'Participants', 'Statut', 'CV', 'Promo'],
        ['2026-11-02', '10:00', '10:30', 'Alumni 1', 'Alice X', '', '', 'Fichier', '2027'],
        [
          '2026-11-02',
          '21:30',
          '22:00',
          'Alumni 1',
          'Bob X',
          '',
          'Annulée',
          'Fichier supprimé',
          '2026',
        ],
      ]);
      expect(first.id).not.toBe(second.id);

      // After the answers' purge, the row stays and its answers are gone.
      await retention.purgeOnce(new Date(Date.parse(paris('22:00')) + 8 * DAY_MS));
      const after = await service.exportBookings(space.id, LABELS, as(ORGA));
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(after.buffer as never);
      const answered = wb2.worksheets[0]
        .getSheetValues()
        .slice(2)
        .map((r) => (r as unknown[]).slice(8));
      expect(answered).toEqual([
        ['', ''],
        ['', ''],
      ]);
      // Two workbooks written and read back: past jest's 5 s default on a loaded run.
    }, 30_000);
  });
});

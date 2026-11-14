/**
 * THE OWNER OF A DRAFT IS NOT LOCKED BY ITS AUTOSAVE, AGAINST POSTGRESQL (owner, 2026-11-09).
 *
 * The first autosave of the create page creates the draft under the association picked then, and
 * that link used to be fixed from that moment: the edit route refused any other value. The rule now
 * (`FormsService.associationAfterEdit`): a DRAFT moves when its actor manages the forms
 * (MANAGE_FORMS, owner 2026-11-14) of the association it leaves and of the one it joins; a PUBLISHED form stays (`FORM_ASSOCIATION_FIXED`). The unit
 * spec (`forms.service.draft.spec.ts`) proves the rule on a fake; this proves the row - what the
 * update and the publication of a revision really WRITE, and what a refusal leaves untouched.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI sets it.
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- form-association-move.integration
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { OpeningReminder } from '../openings/entities/opening-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { PurchaseRecord } from '../users/entities/purchase-record.entity';
import { PurchaseRecordService } from '../users/purchase-record.service';
import {
  FORM_ASSOCIATION_FIXED,
  FORM_ASSOCIATION_NOT_YOURS,
  FORM_ASSOCIATION_UNKNOWN,
  FormsService,
} from './forms.service';
import { FORM_DRAFT, FORM_PUBLISHED, type FormStatus } from './form-status';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { readFormDraft } from './form-draft-revision';
import type { CreateFormDto } from './dto/form.dto';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const ASSO_A = '00000000-0000-4000-8000-0000000000a1';
const ASSO_B = '00000000-0000-4000-8000-0000000000b2';
const OWNER = 'u-owner';
const CO_MANAGER = 'u-co-manager';

maybe('the association of a form, against PostgreSQL', () => {
  const schema = `form_assoc_move_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let service: FormsService;
  /** `${userId}:${associationId}` for every MANAGE_FORMS the stub answers yes to. */
  const members = new Set<string>();

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [Form, Submission, OpeningReminder, FormRespondent, PurchaseRecord],
      synchronize: true,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    await ds.query(readFileSync(join(__dirname, '../migrations/146_form_drafts.sql'), 'utf8'));
    // A publication under an association tells its followers (engagement WP-4,
    // `announceOpeningToFollowers`): the tables that statement reads, in the shape it reads them.
    // Nobody follows here, so it writes no row - this file is about the association link.
    await ds.query(
      `CREATE TABLE associations (id uuid PRIMARY KEY, archived boolean NOT NULL DEFAULT false)`
    );
    await ds.query(
      `CREATE TABLE users (id varchar PRIMARY KEY, admin boolean NOT NULL DEFAULT false,
         campus varchar, cursus jsonb NOT NULL DEFAULT '[]')`
    );
    await ds.query(`CREATE TABLE spaces (formation varchar NOT NULL, campus varchar NOT NULL)`);
    await ds.query(
      `CREATE TABLE association_audiences ("associationId" uuid NOT NULL, formation varchar, campus varchar)`
    );
    await ds.query(
      `CREATE TABLE association_members ("associationId" uuid NOT NULL, "userId" varchar NOT NULL)`
    );
    await ds.query(
      `CREATE TABLE association_follows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         "followerUserId" varchar NOT NULL, "associationId" uuid NOT NULL)`
    );

    service = new FormsService(
      ds.getRepository(Form),
      ds.getRepository(Submission),
      ds.getRepository(OpeningReminder),
      { get: () => 'https://canari.example' } as any,
      {
        isMember: async (userId: string, associationId: string) =>
          members.has(`${userId}:${associationId}`),
        // MANAGE_FORMS where `members` says so; no other flag (MANAGE_MEMBERS) anywhere.
        mayAct: async (userId: string, associationId: string, flag: number) =>
          flag === AssociationPermissionFlag.MANAGE_FORMS &&
          members.has(`${userId}:${associationId}`),
        canTakePaymentsNow: async () => true,
        collectionSubjectOf: async () => null,
        // A and B exist; nothing else does (`forms."associationId"` has no foreign key here either).
        namesByIds: async (ids: string[]) =>
          new Map(ids.filter((id) => id === ASSO_A || id === ASSO_B).map((id) => [id, 'Asso'])),
      } as any,
      { listCotisationTiers: async () => [] } as any,
      new PurchaseRecordService(ds.getRepository(PurchaseRecord)),
      { build: async () => ({ answers: {} }) } as any,
      ds.getRepository(FormRespondent),
      {} as any,
      { enabled: () => false } as any,
      {
        claimForSave: async () => [],
        bindToForm: async () => undefined,
        releaseUncited: async () => undefined,
      } as any
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(() => {
    members.clear();
    // The co-manager manages A's forms only.
    members.add(`${OWNER}:${ASSO_A}`).add(`${OWNER}:${ASSO_B}`).add(`${CO_MANAGER}:${ASSO_A}`);
  });

  /** A free form of OWNER under `associationId`, in `status`. */
  async function form(
    status: FormStatus,
    associationId: string | null = ASSO_A,
    over: Partial<Form> = {}
  ): Promise<string> {
    const repo = ds.getRepository(Form);
    const saved = await repo.save(
      repo.create({
        ownerId: OWNER,
        title: 'Gala',
        basePrice: 0,
        currency: 'eur',
        associationId,
        status,
        items: [],
        ...over,
      })
    );
    return saved.id;
  }

  const edit = (associationId: string | null | undefined) =>
    ({ title: 'Gala', basePrice: 0, currency: 'eur', items: [], associationId }) as CreateFormDto;

  const stored = async (id: string) =>
    (await ds.query(`SELECT "associationId", status FROM forms WHERE id = $1`, [id]))[0] as {
      associationId: string | null;
      status: string;
    };

  it('moves a draft between two associations its actor belongs to, both ways and to none', async () => {
    const id = await form(FORM_DRAFT);
    await service.update(id, edit(ASSO_B), OWNER, false);
    expect(await stored(id)).toEqual({ associationId: ASSO_B, status: FORM_DRAFT });
    await service.update(id, edit(''), OWNER, false);
    expect((await stored(id)).associationId).toBeNull();
    await service.update(id, edit(ASSO_A), OWNER, false);
    expect((await stored(id)).associationId).toBe(ASSO_A);
    // Absent leaves it.
    await service.update(id, edit(undefined), OWNER, false);
    expect((await stored(id)).associationId).toBe(ASSO_A);
  });

  it('refuses a draft to an association whose forms its actor does not manage, and writes nothing', async () => {
    const id = await form(FORM_DRAFT);
    members.delete(`${OWNER}:${ASSO_B}`);
    await expect(service.update(id, edit(ASSO_B), OWNER, false)).rejects.toMatchObject({
      response: { code: FORM_ASSOCIATION_NOT_YOURS },
    });
    expect((await stored(id)).associationId).toBe(ASSO_A);
  });

  it('refuses a co-manager of A moving a draft to B, whose forms they do not manage', async () => {
    const id = await form(FORM_DRAFT);
    await expect(service.update(id, edit(ASSO_B), CO_MANAGER, false)).rejects.toMatchObject({
      response: { code: FORM_ASSOCIATION_NOT_YOURS },
    });
    expect((await stored(id)).associationId).toBe(ASSO_A);
    // An edit that leaves the association alone is theirs to make.
    await service.update(id, { ...edit(undefined), title: 'Gala 2' }, CO_MANAGER, false);
    expect((await stored(id)).associationId).toBe(ASSO_A);
  });

  it('refuses moving a PUBLISHED form, even for a global admin, and writes nothing', async () => {
    const id = await form(FORM_PUBLISHED);
    for (const isGlobalAdmin of [false, true]) {
      await expect(service.update(id, edit(ASSO_B), OWNER, isGlobalAdmin)).rejects.toMatchObject({
        response: { code: FORM_ASSOCIATION_FIXED },
      });
    }
    expect(await stored(id)).toEqual({ associationId: ASSO_A, status: FORM_PUBLISHED });
  });

  it('publishes a draft whose autosaved revision moved it: the form goes live under the new one', async () => {
    const id = await form(FORM_DRAFT);
    // The autosave: the association rides in the revision like every other field.
    await service.saveDraft(id, 0, { ...edit(ASSO_B), title: 'Gala B' }, null, OWNER, false);
    expect((await stored(id)).associationId).toBe(ASSO_A);
    await service.publishChanges(id, 1, OWNER, false);
    expect(await stored(id)).toEqual({ associationId: ASSO_B, status: FORM_PUBLISHED });
    expect((await readFormDraft(ds.manager, id)).document).toBeNull();
  });

  it('refuses publishing that revision by a co-manager of the old association alone, and keeps it', async () => {
    const id = await form(FORM_DRAFT);
    await service.saveDraft(id, 0, edit(ASSO_B), null, OWNER, false);
    await expect(service.publishChanges(id, 1, CO_MANAGER, false)).rejects.toMatchObject({
      response: { code: FORM_ASSOCIATION_NOT_YOURS },
    });
    // Rolled back: still a draft under A, and the revision still there to be published by the owner.
    expect(await stored(id)).toEqual({ associationId: ASSO_A, status: FORM_DRAFT });
    expect((await readFormDraft(ds.manager, id)).document).toMatchObject({ associationId: ASSO_B });
  });

  it('refuses publishing a GRANTING draft moved to an association whose members its actor may not manage, though the revision leaves the grant out', async () => {
    // Review of #3198: the grant is the STORED one, so a revision that omits `grantsCotisation`
    // still carries it into B - and B's MANAGE_MEMBERS is what granting B's cotisation needs.
    const id = await form(FORM_DRAFT, ASSO_A, {
      grantsCotisation: true,
      requiresPayment: true,
      basePrice: 1500,
      allowCashPayment: true,
    });
    await service.saveDraft(
      id,
      0,
      { title: 'Gala', basePrice: 1500, currency: 'eur', items: [], associationId: ASSO_B },
      null,
      OWNER,
      false
    );
    await expect(service.publishChanges(id, 1, OWNER, false)).rejects.toThrow(
      /manage this association members/i
    );
    expect(await stored(id)).toEqual({ associationId: ASSO_A, status: FORM_DRAFT });
  });

  it('refuses, typed, a move to an id that is no UUID or names no association, and writes nothing', async () => {
    const id = await form(FORM_DRAFT);
    for (const [target, admin] of [
      ['x', false],
      ['00000000-0000-4000-8000-00000000dead', true],
    ] as const) {
      await expect(service.update(id, edit(target), OWNER, admin)).rejects.toMatchObject({
        response: { code: FORM_ASSOCIATION_UNKNOWN },
      });
    }
    expect((await stored(id)).associationId).toBe(ASSO_A);
  });
});

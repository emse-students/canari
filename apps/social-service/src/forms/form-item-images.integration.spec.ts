/**
 * A QUESTION'S IMAGE, against a REAL PostgreSQL - migration 136.
 *
 * The citation check is a jsonb containment and the lock an advisory one, so what they DO is a fact
 * about PostgreSQL. `FormItemImagesService` runs here on a real connection with only the media
 * service faked (a store applying its public-asset allowlist): NO row for an id already cited
 * before 136 (its origin was never recorded - a logo pasted into a question), the claim at create and on edit, another form's image refused, a duplicated question citing
 * its source's image, a replace, a remove, a form deleted, an upload never saved, and a release the
 * media service refuses.
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like the other integration files; CI's
 * `test-social-integration` sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- form-item-images.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { BadRequestException } from '@nestjs/common';
import { FormItemImage } from './entities/form-item-image.entity';
import { FormItemImagesService, questionImageUrl } from './form-item-images.service';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (file: string) => readFileSync(join(__dirname, '..', 'migrations', file), 'utf8');

const ALICE = 'alice-0000';
const BOB = 'bob-00000';

maybe('question images against PostgreSQL (migrations 136, 143)', () => {
  const schema = `form_item_images_it_${Math.random().toString(36).slice(2, 10)}`;
  let admin: Client;
  let ds: DataSource;
  let images: FormItemImagesService;
  /** The media service's public assets; anything else it refuses to delete. */
  const publicAssets = new Set<string>();
  const http = {
    post: jest.fn((_url: string, body: { mediaIds: string[] }) => {
      const deleted: string[] = [];
      const refused: string[] = [];
      for (const id of body.mediaIds) {
        if (publicAssets.delete(id)) deleted.push(id);
        else refused.push(id);
      }
      return of({ data: { deleted, refused } });
    }),
  };

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params);

  const item = (id: string, mediaId?: string) => ({
    id,
    label: id,
    type: 'short',
    required: false,
    ...(mediaId ? { imageUrl: questionImageUrl(mediaId) } : {}),
  });

  async function form(items: unknown[], ownerId = ALICE): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO forms (id, "ownerId", items) VALUES ($1, $2, $3)`, [
      id,
      ownerId,
      JSON.stringify(items),
    ]);
    return id;
  }

  /** An upload as the route records it: a public asset, and its row. */
  async function upload(formId: string | null, uploaderId = ALICE, ageHours = 0): Promise<string> {
    const mediaId = randomUUID();
    publicAssets.add(mediaId);
    await images.record(mediaId, formId, uploaderId);
    if (ageHours > 0) {
      await q(
        `UPDATE form_item_images SET "createdAt" = NOW() - make_interval(hours => $2) WHERE "mediaId" = $1`,
        [mediaId, ageHours]
      );
    }
    return mediaId;
  }

  /** A save as `FormsService.update` does it: claim and write in one transaction. */
  async function save(formId: string, items: unknown[], callerId = ALICE): Promise<void> {
    await ds.transaction(async (m) => {
      await images.claimForSave(m, items, formId, callerId);
      await m.query(`UPDATE forms SET items = $2 WHERE id = $1`, [formId, JSON.stringify(items)]);
    });
  }

  const rowOf = async (mediaId: string) =>
    (
      (await q(`SELECT "formId" FROM form_item_images WHERE "mediaId" = $1`, [mediaId])) as {
        formId: string | null;
      }[]
    )[0];

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [FormItemImage],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    });
    await ds.initialize();
    // The table 136 reads, in the shape it needs of it - with two forms already citing images.
    await q(`
      CREATE TABLE forms (
        id uuid PRIMARY KEY,
        "ownerId" varchar(255) NOT NULL,
        items jsonb NOT NULL DEFAULT '[]',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
    // The unpublished revisions (143): an image only a revision cites is cited all the same.
    await q(migration('143_form_drafts.sql'));
    images = new FormItemImagesService(http as any, ds.getRepository(FormItemImage));
  });

  afterAll(async () => {
    await ds?.destroy();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('writes no row for an id a form cited before 136, so its owner can never have it deleted', async () => {
    // A logo pasted into a question before the URL was checked: same shape as an upload, unknown origin.
    const logo = randomUUID();
    publicAssets.add(logo);
    const formId = await form([item('q1', logo), item('q2', logo)]);
    // Applied TWICE: the deploy re-runs every migration, so 136 must be a no-op the second time.
    await q(migration('136_form_item_images.sql'));
    await q(migration('136_form_item_images.sql'));
    expect(await q(`SELECT "mediaId" FROM form_item_images`)).toEqual([]);
    // Its next save keeping it is refused; one dropping it releases nothing (no row, no licence).
    await expect(save(formId, [item('q1', logo)])).rejects.toThrow(BadRequestException);
    await save(formId, [item('q1')]);
    await images.releaseUncited([logo], 'question edited');
    await images.reconcileOnce();
    expect(publicAssets.has(logo)).toBe(true);
  });

  it('binds an upload from the create page to the form its uploader saves, and refuses anyone else', async () => {
    const mediaId = await upload(null);
    const formId = await form([]);
    await expect(save(formId, [item('q1', mediaId)], BOB)).rejects.toThrow(BadRequestException);
    expect((await rowOf(mediaId)).formId).toBeNull();
    await save(formId, [item('q1', mediaId)], ALICE);
    expect((await rowOf(mediaId)).formId).toBe(formId);
  });

  it("refuses an image of another form, an unrecorded id, and lets the form's co-manager cite its own", async () => {
    const formA = await form([]);
    const formB = await form([]);
    const ofA = await upload(formA, ALICE);
    await expect(save(formB, [item('q1', ofA)])).rejects.toThrow(BadRequestException);
    await expect(save(formB, [item('q1', randomUUID())])).rejects.toThrow(BadRequestException);
    await save(formA, [item('q1', ofA)], BOB);
  });

  it('keeps an image a duplicated question still cites, and releases it with the last copy', async () => {
    const mediaId = await upload(null);
    const formId = await form([]);
    await save(formId, [item('q1', mediaId), item('q1-copy', mediaId)]);

    await save(formId, [item('q1-copy', mediaId)]);
    await images.releaseUncited([mediaId], 'question edited');
    expect(publicAssets.has(mediaId)).toBe(true);
    expect(await rowOf(mediaId)).toBeDefined();

    await save(formId, [item('q1-copy')]);
    await images.releaseUncited([mediaId], 'question edited');
    expect(publicAssets.has(mediaId)).toBe(false);
    expect(await rowOf(mediaId)).toBeUndefined();
  });

  it('releases a replaced image and keeps its replacement', async () => {
    const formId = await form([]);
    const first = await upload(formId);
    await save(formId, [item('q1', first)]);
    const second = await upload(formId);
    await save(formId, [item('q1', second)]);
    await images.releaseUncited([first], 'question edited');
    expect([publicAssets.has(first), publicAssets.has(second)]).toEqual([false, true]);
  });

  it("releases a deleted form's images, keeps an archived one's (its row still cites them)", async () => {
    const removed = await form([]);
    const archived = await form([]);
    const a = await upload(removed);
    const b = await upload(archived);
    await save(removed, [item('q1', a)]);
    await save(archived, [item('q1', b)]);
    await q(`DELETE FROM forms WHERE id = $1`, [removed]);
    await images.releaseUncited([a, b], 'form deleted');
    expect([publicAssets.has(a), publicAssets.has(b)]).toEqual([false, true]);
  });

  it('never touches an id with no row, even uncited', async () => {
    const stranger = randomUUID();
    publicAssets.add(stranger);
    await images.releaseUncited([stranger], 'question edited');
    expect(publicAssets.has(stranger)).toBe(true);
  });

  it('keeps the row when the media service refuses, so nothing is forgotten', async () => {
    const formId = await form([]);
    const mediaId = await upload(formId);
    publicAssets.delete(mediaId); // the media service no longer calls it a public asset
    await images.releaseUncited([mediaId], 'question edited');
    expect(await rowOf(mediaId)).toBeDefined();
  });

  it('reconciles only uploads past the grace that no form cites', async () => {
    const formId = await form([]);
    const fresh = await upload(null, ALICE, 0);
    const abandoned = await upload(null, ALICE, 25);
    const citedOld = await upload(formId, ALICE, 25);
    await save(formId, [item('q1', citedOld)]);
    await images.reconcileOnce();
    expect([
      publicAssets.has(fresh),
      publicAssets.has(abandoned),
      publicAssets.has(citedOld),
    ]).toEqual([true, false, true]);
  });

  it('keeps an image only an unpublished revision cites, and releases it once the revision is emptied', async () => {
    const formId = await form([]);
    const added = await upload(formId, ALICE, 25);
    await q(`INSERT INTO form_drafts ("formId", revision, document) VALUES ($1, 1, $2)`, [
      formId,
      JSON.stringify({ title: 't', items: [item('q1', added)] }),
    ]);
    await images.reconcileOnce();
    await images.releaseUncited([added], 'question edited');
    expect(publicAssets.has(added)).toBe(true);
    // Discarded: the revision cites nothing any more.
    await q(`UPDATE form_drafts SET document = NULL, revision = 2 WHERE "formId" = $1`, [formId]);
    await images.releaseUncited([added], 'form revision discarded');
    expect(publicAssets.has(added)).toBe(false);
  });
});

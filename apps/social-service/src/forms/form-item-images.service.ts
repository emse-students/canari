import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import type { EntityManager, Repository } from 'typeorm';
import { mediaUrl } from '../internal/service-urls';
import { describeHttpError } from '../common/http-error-log';
import { FormItemImage } from './entities/form-item-image.entity';

const internalHeaders = () => ({ 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' });

/** The one shape a question's `imageUrl` may take: the public route of a media id. */
export const QUESTION_IMAGE_URL_RE =
  /^\/api\/media\/public\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The longest text alternative a question's image takes. */
export const QUESTION_IMAGE_ALT_MAX_LENGTH = 300;

/** How long an upload no form cites is kept for the save that will cite it. */
export const UNCITED_IMAGE_GRACE_HOURS = 24;

/** The public URL a question stores for `mediaId`. */
export function questionImageUrl(mediaId: string): string {
  return `/api/media/public/${mediaId}`;
}

/** The media id a question's `imageUrl` names, or null when it names none (absent, empty). */
export function questionImageId(imageUrl: unknown): string | null {
  if (typeof imageUrl !== 'string' || imageUrl === '') return null;
  const match = QUESTION_IMAGE_URL_RE.exec(imageUrl);
  return match ? match[1] : null;
}

/** Every distinct image id the questions cite - a duplicated question cites its source's once. */
export function questionImageIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const ids = new Set<string>();
  for (const item of items) {
    const id = questionImageId((item as { imageUrl?: unknown } | null)?.imageUrl);
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * The lock every write that changes WHO CITES an image takes on its id, inside its transaction: a
 * save citing it (held until the form row commits) and a release (held across its re-read of the
 * citations and the delete). A release therefore never reads "uncited" while a save citing it is
 * between its check and its commit. Taken in sorted order so two saves never deadlock.
 */
async function lockImages(m: Pick<EntityManager, 'query'>, mediaIds: string[]): Promise<void> {
  for (const id of [...mediaIds].sort()) {
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `form-item-image:${id}`,
    ]);
  }
}

/** Whether any form - archived ones included - still cites `mediaId` in one of its questions. */
async function isCited(m: Pick<EntityManager, 'query'>, mediaId: string): Promise<boolean> {
  const rows = (await m.query(`SELECT 1 FROM forms WHERE items @> $1::jsonb LIMIT 1`, [
    JSON.stringify([{ imageUrl: questionImageUrl(mediaId) }]),
  ])) as unknown[];
  return rows.length > 0;
}

/**
 * THE LIFETIME OF A QUESTION'S IMAGE (owner, 2026-11-06: "joindre une image a une question, au meme
 * titre qu'une description").
 *
 * The image is a PUBLIC asset (no session to read it, so a guest on a public form sees it), stored at
 * the 1600 px `content` bound. `form_item_images` (migration 136) records each one, and is the
 * allowlist of everything below:
 * - an UPLOAD records its row - on the form when it has one (`formId`), unbound from the create page;
 * - a SAVE may cite only an image whose row is this form's, or an unbound one its caller uploaded,
 *   which the save then binds (`claimForSave`, inside the save's transaction, under each image's
 *   lock). An id is not a secret: without this, a manager could cite another form's image, then
 *   remove it and have it deleted under the other form;
 * - a RELEASE deletes the blob, then the row, once NO form cites it - re-read under the lock: an
 *   image replaced or removed, its form deleted. A duplicated question cites the same id, so the
 *   image stays while either copy does. An archived form still cites its images;
 * - the hourly RECONCILIATION releases every row older than a day that no form cites: an upload
 *   never saved, a form or an association removed, a release that failed.
 */
@Injectable()
export class FormItemImagesService {
  private readonly logger = new Logger(FormItemImagesService.name);
  private reconciling = false;

  constructor(
    private readonly http: HttpService,
    @InjectRepository(FormItemImage) private readonly images: Repository<FormItemImage>
  ) {}

  /** Records an image just uploaded by `uploaderId`, for `formId` (null: the form does not exist yet). */
  async record(mediaId: string, formId: string | null, uploaderId: string): Promise<void> {
    await this.images.insert({ mediaId, formId, uploaderId });
    this.logger.log(
      `[FORM_IMAGE] recorded media=${mediaId.slice(0, 8)} form=${formId?.slice(0, 8) ?? 'unbound'} by=${uploaderId.slice(0, 8)}`
    );
  }

  /**
   * Deletes a blob just uploaded whose row could not be written: with no row it is on no allowlist,
   * so nothing would ever release it. Best-effort; a failure is logged with the id.
   */
  async deleteUnrecorded(mediaId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          mediaUrl('media/internal/public-asset-delete'),
          { mediaIds: [mediaId] },
          { headers: internalHeaders() }
        )
      );
    } catch (err) {
      this.logger.error(
        `[FORM_IMAGE] media=${mediaId} stored with no row and NOT deleted - an orphan public asset: ${describeHttpError(err)}`
      );
    }
  }

  /**
   * Inside `m`, the transaction that will store the form: locks every image `items` cites, refuses
   * the save (400 `QUESTION_IMAGE_NOT_YOURS`) unless each one is this form's or an unbound upload of
   * `callerId`, and binds the unbound ones to `formId`. `formId` is null on a create, whose row has
   * no id yet - call {@link bindToForm} once it does.
   */
  async claimForSave(
    m: Pick<EntityManager, 'query'>,
    items: unknown,
    formId: string | null,
    callerId: string
  ): Promise<string[]> {
    const ids = questionImageIds(items);
    if (ids.length === 0) return ids;
    await lockImages(m, ids);
    const rows = (await m.query(
      `SELECT "mediaId", "formId", "uploaderId" FROM form_item_images WHERE "mediaId" = ANY($1)`,
      [ids]
    )) as Array<{ mediaId: string; formId: string | null; uploaderId: string }>;
    const byId = new Map(rows.map((r) => [r.mediaId, r]));
    for (const id of ids) {
      const row = byId.get(id);
      const allowed =
        row !== undefined &&
        ((formId !== null && row.formId === formId) ||
          (row.formId === null && row.uploaderId === callerId));
      if (!allowed) {
        this.logger.warn(
          `[FORM_IMAGE] save refused: media=${id.slice(0, 8)} is ${row ? `form=${row.formId?.slice(0, 8) ?? 'unbound'}'s` : 'not a recorded question image'}, cited by user=${callerId.slice(0, 8)} on form=${formId?.slice(0, 8) ?? 'new'}`
        );
        throw new BadRequestException({
          code: 'QUESTION_IMAGE_NOT_YOURS',
          message: 'A question may show only an image uploaded for this form.',
        });
      }
    }
    if (formId !== null) await this.bindToForm(m, ids, formId);
    return ids;
  }

  /** Binds the unbound rows among `ids` to `formId` - the claim's second half on a create. */
  async bindToForm(m: Pick<EntityManager, 'query'>, ids: string[], formId: string): Promise<void> {
    if (ids.length === 0) return;
    await m.query(
      `UPDATE form_item_images SET "formId" = $2 WHERE "mediaId" = ANY($1) AND "formId" IS NULL`,
      [ids, formId]
    );
  }

  /**
   * Releases the images among `mediaIds` that no form cites any more: the blob first, then the row,
   * each in its own transaction under its lock. Best-effort and never throws: a failure is logged
   * with its id, and the hourly reconciliation finds it again.
   */
  async releaseUncited(mediaIds: string[], why: string): Promise<void> {
    let released = 0;
    let kept = 0;
    for (const id of new Set(mediaIds)) {
      try {
        const outcome = await this.images.manager.transaction(async (m) => {
          await lockImages(m, [id]);
          const row = (await m.query(`SELECT 1 FROM form_item_images WHERE "mediaId" = $1`, [
            id,
          ])) as unknown[];
          // The allowlist: an id with no row was never a question image, whatever a form says.
          if (row.length === 0) return 'unlisted' as const;
          if (await isCited(m, id)) return 'cited' as const;
          const res = await firstValueFrom(
            this.http.post<{ deleted: string[]; refused: string[] }>(
              mediaUrl('media/internal/public-asset-delete'),
              { mediaIds: [id] },
              { headers: internalHeaders() }
            )
          );
          if (!(res.data?.deleted ?? []).includes(id)) return 'refused' as const;
          await m.query(`DELETE FROM form_item_images WHERE "mediaId" = $1`, [id]);
          return 'released' as const;
        });
        if (outcome === 'released') released++;
        else if (outcome === 'cited') kept++;
        else if (outcome === 'refused') {
          this.logger.error(
            `[FORM_IMAGE] media=${id} (${why}): the media service refused the delete - it is not a public asset, so the row is wrong; left for a look`
          );
        } else {
          this.logger.debug(`[FORM_IMAGE] media=${id} (${why}): not a recorded question image`);
        }
      } catch (err) {
        this.logger.warn(
          `[FORM_IMAGE] media=${id} NOT released (${why}) - retried by the hourly reconciliation: ${describeHttpError(err)}`
        );
      }
    }
    if (released + kept > 0) {
      this.logger.log(
        `[FORM_IMAGE] (${why}): ${released} released, ${kept} kept (still cited by a question)`
      );
    }
  }

  /** Hourly, at :19 - off the minutes the other purges use. */
  @Cron('19 * * * *')
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.logger.warn(`[FORM_IMAGE] reconciliation still running - this tick is skipped`);
      return;
    }
    this.reconciling = true;
    try {
      await this.reconcileOnce();
    } catch (e) {
      this.logger.warn(
        `[FORM_IMAGE] reconciliation failed - retried next hour: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Hands every row older than the grace that no form cites to {@link releaseUncited}, which
   * re-reads each under its lock. Returns how many were handed over.
   */
  async reconcileOnce(): Promise<number> {
    const rows = (await this.images.query(
      `SELECT i."mediaId" FROM form_item_images i
        WHERE i."createdAt" <= NOW() - make_interval(hours => $1)
          AND NOT EXISTS (
            SELECT 1 FROM forms f
             WHERE f.items @> jsonb_build_array(jsonb_build_object('imageUrl', '/api/media/public/' || i."mediaId"::text))
          )`,
      [UNCITED_IMAGE_GRACE_HOURS]
    )) as Array<{ mediaId: string }>;
    if (rows.length === 0) return 0;
    this.logger.log(
      `[FORM_IMAGE] reconciliation: ${rows.length} image(s) no form cites after ${UNCITED_IMAGE_GRACE_HOURS} h - released`
    );
    await this.releaseUncited(
      rows.map((r) => r.mediaId),
      'reconciliation'
    );
    return rows.length;
  }
}

import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, type EntityManager } from 'typeorm';
import {
  cleanFileName,
  detectFormFileType,
  FileBlobGoneError,
  FILE_QUESTION_TYPE,
  FORM_FILE_MAX_BYTES,
  FORM_FILE_MAX_PENDING,
  FORM_FILE_UPLOAD_WINDOW_DAYS,
  FORM_ITEM_ID_MAX_LENGTH,
  FormFilesService,
  type FileAnswer,
  type UploadedFormFile,
} from '../forms/form-files.service';
import { describeHttpError } from '../common/http-error-log';
import { BookingFile } from './entities/booking-file.entity';
import type { BookingSpace } from './entities/booking-space.entity';
import type { BookingFileState } from './booking-views';

/**
 * How many unsent uploads one account may hold across EVERY space at once - three spaces' worth of
 * {@link FORM_FILE_MAX_PENDING}, so an ordinary member never meets it, and the store's exposure to
 * one account is bounded whatever the number of spaces it may book (review of #2045).
 */
export const BOOKING_FILE_MAX_PENDING_PER_ACCOUNT = 3 * FORM_FILE_MAX_PENDING;

/**
 * THE FILE QUESTION OF A BOOKING (D7, D22, WP-B6) - the forms' file question, for a space.
 *
 * ONE STORAGE FOR BOTH MODULES. The bytes are the media service's class `form-file`: plaintext,
 * because the organiser must open the CV (D22), and served by no route but the internal one, behind
 * the internal secret. `FormFilesService` stores them, fetches them and deletes them; this service
 * owns the bookings half - its table (`booking_files`, migration 092), the ownership rule at booking
 * time, and the organiser's download. Every limit is the forms' own constant (8 MiB, PDF/JPEG/PNG/
 * WebP read from the bytes, one day to send an upload, ten unsent uploads per member and space),
 * plus one of its own: thirty unsent uploads per member across spaces.
 *
 * The answer stores the file's id, as a form answer does. Retention counts from the END OF THE
 * SLOT (D41), `retentionDays` of the space - `booking-retention.scheduler.ts`.
 */
@Injectable()
export class BookingFilesService {
  private readonly logger = new Logger(BookingFilesService.name);

  constructor(
    @InjectRepository(BookingFile) private readonly files: Repository<BookingFile>,
    private readonly formFiles: FormFilesService
  ) {}

  /**
   * Stores a booker's file for one FILE question of a space, before the booking is sent. The caller
   * has judged the space's audience (the same rule as a booking). Refused: a question that is not a
   * file question of this space; an empty or oversized file; a type other than PDF, JPEG, PNG or
   * WebP (read from the bytes); a member already holding {@link FORM_FILE_MAX_PENDING} unsent
   * uploads on this space.
   */
  async upload(
    space: Pick<BookingSpace, 'id' | 'items'>,
    itemId: string | undefined,
    file: { buffer: Buffer; size: number; originalname?: string },
    uploaderId: string
  ): Promise<UploadedFormFile> {
    const items = (space.items ?? []) as { id?: string; type?: string }[];
    const item =
      typeof itemId === 'string' && itemId.length > 0 && itemId.length <= FORM_ITEM_ID_MAX_LENGTH
        ? items.find((i) => i.id === itemId)
        : undefined;
    if (!item?.id || item.type !== FILE_QUESTION_TYPE) {
      this.logger.debug(
        `[BOOKING_FILES] upload refused: no file question ${itemId} on ${space.id}`
      );
      throw new BadRequestException({ code: 'file-question' });
    }
    if (!file.buffer || file.size === 0) throw new BadRequestException({ code: 'file-empty' });
    if (file.size > FORM_FILE_MAX_BYTES || file.buffer.length > FORM_FILE_MAX_BYTES) {
      throw new PayloadTooLargeException({ code: 'file-too-large', max: FORM_FILE_MAX_BYTES });
    }
    const contentType = detectFormFileType(file.buffer);
    if (!contentType) {
      this.logger.debug(
        `[BOOKING_FILES] upload refused: not a PDF, JPEG, PNG or WebP (${space.id})`
      );
      throw new BadRequestException({ code: 'file-type' });
    }

    // Read before the bytes travel; the GATE is the same count under a lock, below.
    await this.assertPendingRoom(this.files.manager, space.id, uploaderId);

    const { mediaId: fileId, sizeBytes } = await this.formFiles.storeBlob(file.buffer, uploaderId);
    const fileName = cleanFileName(file.originalname, contentType, fileId);
    try {
      await this.files.manager.transaction(async (tx) => {
        // Per ACCOUNT, since the account-wide cap counts across spaces.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `booking_files:${uploaderId}`,
        ]);
        await this.assertPendingRoom(tx, space.id, uploaderId);
        await tx.insert(BookingFile, {
          id: fileId,
          spaceId: space.id,
          itemId: item.id,
          uploaderId,
          contentType,
          fileName,
          sizeBytes,
          bookingId: null,
          purgedAt: null,
        });
      });
    } catch (e) {
      // The blob exists and no row names it: nothing would ever purge it. Taken back now.
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        this.logger.warn(
          `[BOOKING_FILES] ${fileId} lost the race for the last pending slot - taken back`
        );
      } else {
        this.logger.error(
          `[BOOKING_FILES] row insert failed for ${fileId} - deleting its blob: ${describeHttpError(e)}`
        );
      }
      const outcome = (await this.formFiles.purgeBlobs([{ mediaId: fileId, ownerId: uploaderId }]))[
        fileId
      ];
      if (outcome !== 'deleted' && outcome !== 'absent') {
        this.logger.error(`[BOOKING_FILES] blob ${fileId} is STRANDED (purge said ${outcome})`);
      }
      throw e;
    }
    this.logger.log(
      `[BOOKING_FILES] upload ${fileId} space=${space.id.slice(0, 8)} item=${item.id} ${contentType} ${sizeBytes} B stored`
    );
    return { fileId, fileName, sizeBytes, contentType };
  }

  /**
   * Refuses (429) a member already holding the cap of unsent uploads: {@link FORM_FILE_MAX_PENDING}
   * on this space (`files-pending`), or {@link BOOKING_FILE_MAX_PENDING_PER_ACCOUNT} across every
   * space (`files-pending-account`) - the per-space cap alone let one account fill the store by
   * spreading its uploads over every space it may book (review of #2045).
   */
  private async assertPendingRoom(
    db: Pick<EntityManager, 'query'>,
    spaceId: string,
    uploaderId: string
  ): Promise<void> {
    const [{ here, total }] = (await db.query(
      `SELECT count(*) FILTER (WHERE "spaceId" = $1)::int AS here, count(*)::int AS total
         FROM booking_files
        WHERE "uploaderId" = $2 AND "bookingId" IS NULL
          AND "purgedAt" IS NULL AND "createdAt" > NOW() - make_interval(hours => 24 * $3::int)`,
      [spaceId, uploaderId, FORM_FILE_UPLOAD_WINDOW_DAYS]
    )) as Array<{ here: number; total: number }>;
    if (here >= FORM_FILE_MAX_PENDING) {
      this.logger.warn(
        `[BOOKING_FILES] upload refused: user=${uploaderId.slice(0, 8)} holds ${here} unsent files on space=${spaceId.slice(0, 8)}`
      );
      throw new HttpException({ code: 'files-pending' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (total >= BOOKING_FILE_MAX_PENDING_PER_ACCOUNT) {
      this.logger.warn(
        `[BOOKING_FILES] upload refused: user=${uploaderId.slice(0, 8)} holds ${total} unsent files across spaces`
      );
      throw new HttpException({ code: 'files-pending-account' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Ties the files a booking cites to it, INSIDE the booking's transaction - one statement per file,
   * so ownership is checked and taken in the same write and two bookings cannot claim one file.
   *
   * THE OWNERSHIP RULE: uploaded by the ACTOR (the booker, or the organiser booking on someone's
   * behalf - whoever picked the file), for THIS space and THIS question, not purged, unsent and
   * inside its one-day window. Anything else is refused `file-not-yours` and the booking rolls back.
   */
  async attach(
    m: EntityManager,
    bookingId: string,
    spaceId: string,
    uploaderId: string,
    files: FileAnswer[]
  ): Promise<void> {
    for (const { itemId, fileId } of files) {
      const rows = (await m.query(
        `WITH claimed AS (
           UPDATE booking_files SET "bookingId" = $1
            WHERE id = $2 AND "spaceId" = $3 AND "itemId" = $4 AND "uploaderId" = $5
              AND "purgedAt" IS NULL AND "bookingId" IS NULL
              AND "createdAt" > NOW() - make_interval(hours => 24 * $6::int)
            RETURNING id)
         SELECT id FROM claimed`,
        [bookingId, fileId, spaceId, itemId, uploaderId, FORM_FILE_UPLOAD_WINDOW_DAYS]
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        this.logger.warn(
          `[BOOKING_FILES] booking refused: file ${fileId} is not user=${uploaderId.slice(0, 8)}'s upload for item=${itemId} of space=${spaceId.slice(0, 8)}, or has expired`
        );
        throw new BadRequestException({ code: 'file-not-yours', itemId });
      }
    }
  }

  /**
   * The files these bookings carry, by id: their booking, the name a download is saved under, and
   * whether the purge took it.
   */
  async answerFiles(bookingIds: string[]): Promise<Map<string, BookingFileState>> {
    if (bookingIds.length === 0) return new Map();
    const rows = await this.files.find({
      where: { bookingId: In(bookingIds) },
      select: { id: true, bookingId: true, fileName: true, purgedAt: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { bookingId: r.bookingId as string, fileName: r.fileName, purged: r.purgedAt !== null },
      ])
    );
  }

  /**
   * The bytes of one booking's file, for its ORGANISER - the caller has run the rights check on the
   * booking's space. Only a file SENT with THIS booking is served (404 `file-not-found` otherwise);
   * a purged one is a 410 `file-purged`. A blob the media service no longer holds (an account
   * deletion took its uploader's files) marks the row purged, so the next reading says so.
   */
  async download(
    bookingId: string,
    fileId: string
  ): Promise<{ data: Buffer; contentType: string; fileName: string }> {
    const row = await this.files.findOne({ where: { id: fileId, bookingId } });
    if (!row) {
      this.logger.debug(`[BOOKING_FILES] download: no file ${fileId} on booking ${bookingId}`);
      throw new NotFoundException({ code: 'file-not-found' });
    }
    if (row.purgedAt) throw new GoneException({ code: 'file-purged' });
    try {
      return {
        data: await this.formFiles.fetchBlob(fileId),
        contentType: row.contentType,
        fileName: row.fileName,
      };
    } catch (e) {
      if (e instanceof FileBlobGoneError) {
        this.logger.warn(
          `[BOOKING_FILES] file ${fileId} of booking ${bookingId.slice(0, 8)} is gone from the media service (${e.status}) - marked purged`
        );
        await this.files.update({ id: fileId, purgedAt: IsNull() }, { purgedAt: new Date() });
        throw new GoneException({ code: 'file-purged' });
      }
      throw e;
    }
  }
}

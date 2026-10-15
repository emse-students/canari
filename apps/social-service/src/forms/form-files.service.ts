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
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, type EntityManager } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import FormData from 'form-data';
import { FormFile } from './entities/form-file.entity';
import { Form } from './entities/form.entity';
import { mediaUrl } from '../internal/service-urls';
import { describeHttpError } from '../common/http-error-log';

/**
 * THE FILE QUESTION OF A FORM - upload, ownership at submit, the managers' download.
 *
 * A file answer is the one answer the server must be able to READ: the form's manager opens the CV,
 * exactly as they read a text answer, so it is not end-to-end encrypted. It is stored by the media
 * service as class `form-file` - plaintext, and served by `GET /media/internal/form-file/:id` only,
 * because neither `GET /media/:id` nor the push proxy's `GET /media/internal/:id` has a per-object
 * ACL. The ONLY reader is `download` below, behind
 * `assertFormManager`. See docs/wiki/frontend/modules/forms.md ("The file question").
 *
 * The answer stores the file's id; this service's table (`form_files`, migration 085) is where that
 * id means something - and where the purge reads its state from (`form-file-retention.scheduler.ts`).
 */

/** The question type whose answer is a file. */
export const FILE_QUESTION_TYPE = 'file';

/**
 * The largest file one answer may carry: 8 MiB, the frontend's per-request budget
 * (`MEDIA_REQUEST_BODY_BUDGET_BYTES`). The host WAF drops any body over 10 MiB with no answer
 * (docs/wiki/infrastructure/host-waf-body-limit.md), and the file travels in ONE multipart request,
 * so the cap leaves 2 MiB for the envelope. A CV is well under 2 MiB as a PDF; a phone photo of a
 * paper document is 2-6 MiB.
 */
export const FORM_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How long an upload may wait for its answer: one day. An upload not sent within it is purged, and
 * an answer can no longer cite it - the two read the same column with the same bound, so a file is
 * never both attachable and being deleted.
 */
export const FORM_FILE_UPLOAD_WINDOW_DAYS = 1;

/** Uploads one member may hold on one form without having sent them, within the window above. */
export const FORM_FILE_MAX_PENDING = 10;

/** The longest question id a file can be filed under: `form_files."itemId"` is varchar(64). */
export const FORM_ITEM_ID_MAX_LENGTH = 64;

/** The bounds and default of `forms.fileRetentionDays` (decisions D23, D41). */
export const FILE_RETENTION_MIN_DAYS = 1;
export const FILE_RETENTION_MAX_DAYS = 30;
export const FILE_RETENTION_DEFAULT_DAYS = 7;

/** The types a file answer may be: what a CV, a certificate or a photo of one is. */
export type FormFileType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

const EXTENSIONS: Record<FormFileType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The type of a file, READ FROM ITS BYTES, or null when it is none of the four allowed.
 *
 * The client's declared MIME type is not looked at: it is a string the client chose, and the type
 * stored here is the `Content-Type` a manager's browser will be handed. An HTML page renamed `cv.pdf`
 * has no PDF signature and is refused.
 */
export function detectFormFileType(data: Buffer): FormFileType | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= png.length && png.every((byte, i) => data[i] === byte)) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * What a file name must not carry: the C0 and C1 control characters, DEL, the double quote a
 * `Content-Disposition` header cannot hold, and the BIDIRECTIONAL controls (U+200E/F, U+061C,
 * U+202A-202E, U+2066-2069) - a right-to-left override turns `cv[U+202E]fdp.exe` into a name that
 * READS `cvexe.pdf` on the manager's screen.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f"‎‏؜‪-‮⁦-⁩]/g;

/**
 * The name a file is filed under: the device's own name, without a path or {@link UNSAFE_NAME_CHARS},
 * and with the extension of its REAL type. Multer hands the name over as latin1 (busboy's default),
 * so UTF-8 bytes are re-read as such. A name that cleans to nothing is the id's first eight
 * characters, never a word in some language.
 */
export function cleanFileName(raw: string | undefined, type: FormFileType, fileId: string): string {
  const decoded = Buffer.from(raw ?? '', 'latin1').toString('utf8');
  const base = decoded.split(/[\\/]/).pop() ?? '';
  const printable = base.replace(UNSAFE_NAME_CHARS, '');
  const stem = printable
    .replace(/\.[^.]*$/, '')
    .trim()
    .slice(0, 180);
  return `${stem || fileId.slice(0, 8)}.${EXTENSIONS[type]}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One question's file answer, as cited by a submission. */
export interface FileAnswer {
  itemId: string;
  fileId: string;
}

/** What a manager's screen knows of one answer's file: its saved name, and whether it is purged. */
export interface AnswerFileState {
  fileName: string;
  purged: boolean;
}

/** Whether a form's questions ask for a file. */
export function hasFileQuestion(items: Array<{ type?: string }> | undefined): boolean {
  return (items ?? []).some((item) => item.type === FILE_QUESTION_TYPE);
}

/**
 * The file answers a submission cites, one per FILE question that has a value - checked for SHAPE
 * here (an id string), for ownership by `attach`. Every file question is read, visible or not: an
 * answer stored under a hidden question is stored all the same, so it must be one the member owns.
 *
 * @throws BadRequestException on a value that is not a file id.
 */
export function fileAnswersOf(
  items: Array<{ id: string; type?: string }>,
  answers: Record<string, unknown> | undefined
): FileAnswer[] {
  const out: FileAnswer[] = [];
  for (const item of items) {
    if (item.type !== FILE_QUESTION_TYPE) continue;
    const value = answers?.[item.id];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException('A file answer must name a file uploaded for this question.');
    }
    out.push({ itemId: item.id, fileId: value });
  }
  return out;
}

/** What an upload answers: the id the answer will carry, and what the page shows of the file. */
export interface UploadedFormFile {
  fileId: string;
  fileName: string;
  sizeBytes: number;
  contentType: FormFileType;
}

@Injectable()
export class FormFilesService {
  private readonly logger = new Logger(FormFilesService.name);

  constructor(
    @InjectRepository(FormFile) private readonly fileRepo: Repository<FormFile>,
    @InjectRepository(Form) private readonly formRepo: Repository<Form>,
    private readonly http: HttpService
  ) {}

  /**
   * Stores a member's file for one FILE question of a form, before the answer is sent.
   *
   * Refused: a form that is gone, public, not open or closed; a question that is not a file question
   * of this form; an empty or oversized file; a type other than PDF, JPEG, PNG or WebP (read from the
   * bytes); a member already holding {@link FORM_FILE_MAX_PENDING} unsent uploads on this form.
   */
  async upload(
    formId: string,
    itemId: string | undefined,
    file: { buffer: Buffer; size: number; originalname?: string },
    uploaderId: string
  ): Promise<UploadedFormFile> {
    if (
      typeof itemId !== 'string' ||
      itemId.length === 0 ||
      itemId.length > FORM_ITEM_ID_MAX_LENGTH
    ) {
      throw new BadRequestException('This question does not ask for a file.');
    }
    const form = await this.formRepo.findOne({ where: { id: formId, deletedAt: IsNull() } });
    if (!form) throw new NotFoundException('Form not found');
    const item = (form.items ?? []).find((i: { id: string }) => i.id === itemId);
    if (!item || item.type !== FILE_QUESTION_TYPE) {
      this.logger.debug(`[FORM_FILES] upload refused: no file question ${itemId} on ${formId}`);
      throw new BadRequestException('This question does not ask for a file.');
    }
    // A public form cannot hold a file question (refused at save); said again here because this is
    // the one route that writes a file, and a guest has no account to own one.
    if (form.isPublic) {
      throw new BadRequestException('A public form cannot receive a file.');
    }
    if (form.opensAt && new Date(form.opensAt) > new Date()) {
      throw new BadRequestException('The form is not open yet.');
    }
    if (form.closedAt && new Date(form.closedAt) < new Date()) {
      throw new BadRequestException('The form is closed.');
    }
    if (!file.buffer || file.size === 0) {
      throw new BadRequestException('The file is empty.');
    }
    if (file.size > FORM_FILE_MAX_BYTES || file.buffer.length > FORM_FILE_MAX_BYTES) {
      throw new PayloadTooLargeException(`A file answer is at most ${FORM_FILE_MAX_BYTES} bytes.`);
    }
    const contentType = detectFormFileType(file.buffer);
    if (!contentType) {
      this.logger.debug(`[FORM_FILES] upload refused: not a PDF, JPEG, PNG or WebP (${formId})`);
      throw new BadRequestException('A file answer must be a PDF, JPEG, PNG or WebP file.');
    }

    // Read before the bytes travel, so a member at the cap is told without an 8 MiB round trip. NOT
    // the gate: two uploads in flight both pass it. The gate is the same count, under a lock, in the
    // transaction that writes the row (below).
    await this.assertPendingRoom(this.fileRepo.manager, formId, uploaderId);

    const { mediaId: fileId, sizeBytes } = await this.storeInMedia(file.buffer, uploaderId);
    const fileName = cleanFileName(file.originalname, contentType, fileId);
    try {
      await this.fileRepo.manager.transaction(async (tx) => {
        // One member's uploads on one form are written one at a time, so the count below cannot be
        // read by two writers at once: an advisory lock on the pair, released with the transaction.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `form_files:${formId}:${uploaderId}`,
        ]);
        await this.assertPendingRoom(tx, formId, uploaderId);
        await tx.insert(FormFile, {
          id: fileId,
          formId,
          itemId: item.id,
          uploaderId,
          contentType,
          fileName,
          sizeBytes,
          submissionId: null,
          attachedAt: null,
          purgedAt: null,
        });
      });
    } catch (e) {
      // The blob exists and no row names it: nothing would ever purge it. Taken back now, and if
      // that fails too the line says which object is stranded.
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        this.logger.warn(
          `[FORM_FILES] ${fileId} lost the race for the last pending slot - taken back`
        );
      } else {
        this.logger.error(
          `[FORM_FILES] row insert failed for ${fileId} - deleting its blob: ${describeHttpError(e)}`
        );
      }
      const outcome = (await this.purgeBlobs([{ mediaId: fileId, ownerId: uploaderId }]))[fileId];
      if (outcome !== 'deleted' && outcome !== 'absent') {
        this.logger.error(`[FORM_FILES] blob ${fileId} is STRANDED (purge said ${outcome})`);
      }
      throw e;
    }
    this.logger.log(
      `[FORM_FILES] upload ${fileId} form=${formId.slice(0, 8)} item=${item.id} ${contentType} ${sizeBytes} B stored (${file.buffer.length} B received)`
    );
    return { fileId, fileName, sizeBytes, contentType };
  }

  /**
   * Refuses (429) a member already holding {@link FORM_FILE_MAX_PENDING} unsent uploads on a form
   * within the upload window. The window is counted in hours (24 x days), as everywhere a
   * `form_files` predicate is written.
   */
  private async assertPendingRoom(
    db: Pick<EntityManager, 'query'>,
    formId: string,
    uploaderId: string
  ): Promise<void> {
    const [{ pending }] = (await db.query(
      `SELECT count(*)::int AS pending FROM form_files
        WHERE "formId" = $1 AND "uploaderId" = $2 AND "submissionId" IS NULL
          AND "purgedAt" IS NULL AND "createdAt" > NOW() - make_interval(hours => 24 * $3::int)`,
      [formId, uploaderId, FORM_FILE_UPLOAD_WINDOW_DAYS]
    )) as Array<{ pending: number }>;
    if (pending >= FORM_FILE_MAX_PENDING) {
      this.logger.warn(
        `[FORM_FILES] upload refused: user=${uploaderId.slice(0, 8)} holds ${pending} unsent files on form=${formId.slice(0, 8)}`
      );
      throw new HttpException(
        'Too many files waiting to be sent on this form. Send your answer first.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  /**
   * Ties the files a submission cites to it, INSIDE the submission's transaction - one statement per
   * file, so ownership is checked and taken in the same write and two answers cannot claim one file.
   *
   * THE OWNERSHIP RULE: the file was uploaded by THIS member, for THIS form and THIS question, is not
   * purged, and is either unsent and inside its upload window, or already this submission's (a paid
   * form re-submitted while pending reuses its row). Anything else throws, and the submission rolls
   * back with it.
   *
   * `attachedAt` - where retention counts from - is the LATER of the transaction's `NOW()` and the
   * submission's `createdAt`. A pending submission that is REUSED keeps its old `createdAt`, and
   * counting from it would cut the file's life short by however long the row waited; `NOW()` alone
   * is this answer's moment.
   *
   * `NOW()` is the transaction's START, so the window closes at the instant the transaction began,
   * not when it commits. A submission begun a hair before the 24th hour of an upload can therefore
   * claim a file the purge, judging at its own later instant, has just selected as unsent. The
   * overlap is the length of one submission's transaction at that one boundary, and its worst case
   * is BENIGN and visible: the blob goes, the answer keeps the id, and the manager's first download
   * meets the media service's 404, marks the row purged and reads "file deleted". Accepted, not
   * healed silently (decided in review of #1908).
   */
  async attach(
    manager: EntityManager,
    submission: { id: string; createdAt: Date },
    formId: string,
    uploaderId: string,
    files: FileAnswer[]
  ): Promise<void> {
    for (const { itemId, fileId } of files) {
      const rows = (await manager.query(
        `WITH claimed AS (
           UPDATE form_files SET "submissionId" = $1, "attachedAt" = GREATEST(NOW(), $2::timestamptz)
            WHERE id = $3 AND "formId" = $4 AND "itemId" = $5 AND "uploaderId" = $6
              AND "purgedAt" IS NULL
              AND (("submissionId" IS NULL
                    AND "createdAt" > NOW() - make_interval(hours => 24 * $7::int))
                   OR "submissionId" = $1)
            RETURNING id)
         SELECT id FROM claimed`,
        [
          submission.id,
          submission.createdAt,
          fileId,
          formId,
          itemId,
          uploaderId,
          FORM_FILE_UPLOAD_WINDOW_DAYS,
        ]
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        this.logger.warn(
          `[FORM_FILES] submit refused: file ${fileId} is not user=${uploaderId.slice(0, 8)}'s upload for item=${itemId} of form=${formId.slice(0, 8)}, or has expired`
        );
        throw new BadRequestException(
          'A file in this answer was not uploaded by you for this question, or has expired. Upload it again.'
        );
      }
    }
  }

  /**
   * The files these submissions carry, by id: the name the manager's download is saved under, and
   * whether the purge took it. The name travels here rather than in the download's
   * Content-Disposition because a cross-origin client (the native shells) cannot read that header.
   */
  async answerFiles(submissionIds: string[]): Promise<Map<string, AnswerFileState>> {
    if (submissionIds.length === 0) return new Map();
    const rows = (await this.fileRepo.query(
      `SELECT id, "fileName", "purgedAt" IS NOT NULL AS purged
         FROM form_files WHERE "submissionId" = ANY($1::uuid[])`,
      [submissionIds]
    )) as Array<{ id: string; fileName: string; purged: boolean }>;
    return new Map(rows.map((r) => [r.id, { fileName: r.fileName, purged: r.purged }]));
  }

  /** The ids of the purged files among these submissions' - what reads as "file deleted". */
  async deletedFileIds(submissionIds: string[]): Promise<Set<string>> {
    const files = await this.answerFiles(submissionIds);
    return new Set([...files].filter(([, state]) => state.purged).map(([id]) => id));
  }

  /**
   * The bytes of one answer's file, for a manager - the caller has run `assertFormManager` on
   * `formId`. Only a file SENT with an answer of THIS form is served: an id from another form, or an
   * upload nobody sent, is a 404. A purged file is a 410.
   *
   * When the media service answers that the blob is gone (an account deletion takes its uploader's
   * files), the row is marked purged here: the media service's answer is the fact the column
   * records, and the next reading says "file deleted" instead of offering a download that fails.
   */
  async download(
    formId: string,
    fileId: string
  ): Promise<{ data: Buffer; contentType: string; fileName: string }> {
    const row = await this.fileRepo.findOne({ where: { id: fileId, formId } });
    if (!row || !row.submissionId) {
      this.logger.debug(`[FORM_FILES] download: no sent file ${fileId} on form ${formId}`);
      throw new NotFoundException('File not found');
    }
    if (row.purgedAt) throw new GoneException('This file was deleted after its retention period.');

    try {
      const res = await firstValueFrom(
        this.http.get<ArrayBuffer>(mediaUrl(`media/internal/form-file/${fileId}`), {
          headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
          responseType: 'arraybuffer',
          maxContentLength: FORM_FILE_MAX_BYTES + 65_536,
        })
      );
      return {
        data: Buffer.from(res.data),
        contentType: row.contentType,
        fileName: row.fileName,
      };
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 410) {
        this.logger.warn(
          `[FORM_FILES] file ${fileId} of form ${formId.slice(0, 8)} is gone from the media service (${status}) - marked purged`
        );
        await this.fileRepo.update({ id: fileId, purgedAt: IsNull() }, { purgedAt: new Date() });
        throw new GoneException('This file was deleted.');
      }
      this.logger.error(`[FORM_FILES] download of ${fileId} failed: ${describeHttpError(e)}`);
      throw e;
    }
  }

  /**
   * Asks the media service to delete form files, each on its uploader's name; one outcome per id.
   * THROWS on a transport or HTTP failure, so a caller never reads a success it did not get.
   */
  async purgeBlobs(
    items: Array<{ mediaId: string; ownerId: string }>
  ): Promise<Record<string, FileBlobOutcome>> {
    if (items.length === 0) return {};
    const res = await firstValueFrom(
      this.http.post<{ results: Record<string, FileBlobOutcome> }>(
        mediaUrl('media/internal/form-file-purge'),
        { items },
        { headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' } }
      )
    );
    return res.data?.results ?? {};
  }

  /**
   * Stores the bytes as a `form-file` for `uploaderId`. The media service re-encodes an image
   * without its metadata (EXIF, GPS), so `sizeBytes` is what it STORED, not what was received.
   * Its 422 - an image that does not decode - is the member's file, answered as a 400.
   */
  private async storeInMedia(
    data: Buffer,
    uploaderId: string
  ): Promise<{ mediaId: string; sizeBytes: number }> {
    const fd = new FormData();
    fd.append('file', data, { filename: 'answer', contentType: 'application/octet-stream' });
    fd.append('ownerId', uploaderId);
    try {
      const res = await firstValueFrom(
        this.http.post<{ mediaId: string; sizeBytes: number }>(
          mediaUrl('media/internal/form-file'),
          fd,
          {
            headers: {
              ...fd.getHeaders(),
              'x-internal-secret': process.env.INTERNAL_SECRET ?? '',
            },
            maxBodyLength: FORM_FILE_MAX_BYTES + 65_536,
          }
        )
      );
      if (!res.data?.mediaId || typeof res.data.sizeBytes !== 'number') {
        throw new Error('the media service returned no mediaId or sizeBytes');
      }
      return { mediaId: res.data.mediaId, sizeBytes: res.data.sizeBytes };
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === HttpStatus.UNPROCESSABLE_ENTITY) {
        this.logger.warn(`[FORM_FILES] upload refused: the image does not decode`);
        throw new BadRequestException('This image could not be read. Send it again as a PDF.');
      }
      this.logger.error(`[FORM_FILES] media upload failed: ${describeHttpError(e)}`);
      throw new HttpException('The file could not be stored. Try again.', HttpStatus.BAD_GATEWAY);
    }
  }
}

/** What the media service answers for one form file it was asked to delete. */
export type FileBlobOutcome = 'deleted' | 'absent' | 'refused' | 'failed';

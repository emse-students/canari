/**
 * UploadSessionService - the streamed, resumable upload (docs/wiki/services/media-streaming-upload.md,
 * WP-S1). Additive: the single-block POST and the `upload/chunk/*` routes are untouched.
 *
 * THE SHAPE, and what each choice replaces in the chunk routes:
 *  - a session is declared at `init` with its exact size, part size and the 20 public header bytes of
 *    the `segmented-v1` blob, and reserves the daily budget ONCE;
 *  - each part is a raw request body PIPED to the staging file at `index * partBytes` - never a
 *    `Buffer` of the body, so memory is the stream's high-water mark, not the part (the chunk route
 *    holds a whole multer buffer), and a re-sent part rewrites the same bytes at the same offset
 *    (the chunk route APPENDS, so a retry after a lost answer corrupted the blob);
 *  - the server's own list of received indexes is the resume fact, kept in a sidecar next to the
 *    staging file so a process restart does not forget it;
 *  - `complete` demands every part and the exact size, and is idempotent through a memo written to the
 *    same sidecar, so a lost answer is answered again with the same `mediaId`.
 *
 * The session directory is NOT the chunk directory: that one is swept by file age, which would take
 * a sidecar that has not changed in a day along with its data, and has no idea what a reservation is.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Readable, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { MediaService, RETENTION_CLASSES, type RetentionClass } from './media.service';
import { StorageService } from './storage.service';
import {
  KeyedMutex,
  MAX_PARTS,
  PART_MAX_BYTES,
  PART_MIN_BYTES,
  SEGMENTED_HEADER_BYTES,
  expectedPartLength,
  parseDeclaredHeader,
  partCount,
} from './upload-session';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOUR_MS = 60 * 60 * 1000;
/** Bytes per `fs.write`, so a part of any size costs this much heap. */
const WRITE_BUFFER_BYTES = 64 * 1024;

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** What the sidecar persists: everything needed to answer `status` after a restart. */
interface SessionRecord {
  id: string;
  ownerId: string;
  retentionClass?: RetentionClass;
  totalBytes: number;
  partBytes: number;
  headerHex: string;
  createdAt: number;
  /** Absolute: the resume window runs from the opening, never extended by activity. */
  expiresAt: number;
  received: number[];
  /**
   * True once ANY part has landed, and never reset: a re-sent part leaves `received` while it is
   * rewritten, and the session must not look untouched (and so expire in minutes) for that.
   */
  everReceived?: boolean;
  /**
   * The id `complete` will register, persisted BEFORE the store is written: a crash anywhere after
   * that point retries into the same object key (the store overwrites it), so no orphan and no
   * second id for one upload.
   */
  intendedMediaId?: string;
  /** Set by `complete`; the memo that makes a repeated `complete` answer the same id. */
  completed?: { mediaId: string; at: number };
}

interface Session extends SessionRecord {
  received: number[];
  receivedSet: Set<number>;
  /** Gives the reserved bytes back; idempotent. */
  release: () => void;
  /** Aborts every in-flight PUT of this session (cancel, expiry). */
  aborts: Set<AbortController>;
  /** Settles when each in-flight PUT has finished unwinding. */
  active: Set<Promise<unknown>>;
  /** True from the moment `complete` starts reading the staging file; a PUT is then refused (409). Memory only. */
  completing: boolean;
}

/** A sidecar that is unreadable as a session, as opposed to one the disk could not be read for. */
class InvalidRecordError extends Error {}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_REGEX.test(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validates a parsed sidecar field by field. Throws {@link InvalidRecordError} - and only that - so
 * `load` can tell a record that is WRONG (safe to delete) from a read that FAILED (never deleted).
 */
function validateRecord(raw: unknown, id: string): SessionRecord {
  const bad = (why: string): never => {
    throw new InvalidRecordError(why);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not an object');
  const r = raw as Record<string, unknown>;
  if (r.id !== id) bad('id differs from the file name');
  if (typeof r.ownerId !== 'string' || r.ownerId.length === 0) bad('ownerId');
  if (!Number.isSafeInteger(r.totalBytes) || (r.totalBytes as number) <= 0) bad('totalBytes');
  if (
    !Number.isSafeInteger(r.partBytes) ||
    (r.partBytes as number) < PART_MIN_BYTES ||
    (r.partBytes as number) > PART_MAX_BYTES
  ) {
    bad('partBytes');
  }
  const parts = partCount(r.totalBytes as number, r.partBytes as number);
  if (parts > MAX_PARTS) bad('too many parts');
  if (typeof r.headerHex !== 'string' || !/^[0-9a-f]{40}$/.test(r.headerHex)) bad('headerHex');
  if (!isFiniteNumber(r.createdAt) || !isFiniteNumber(r.expiresAt)) bad('timestamps');
  if (
    r.retentionClass !== undefined &&
    !(typeof r.retentionClass === 'string' && RETENTION_CLASSES.has(r.retentionClass))
  ) {
    bad('retentionClass');
  }
  if (
    !Array.isArray(r.received) ||
    !r.received.every((i) => Number.isInteger(i) && i >= 0 && i < parts)
  ) {
    bad('received');
  }
  if (r.everReceived !== undefined && typeof r.everReceived !== 'boolean') bad('everReceived');
  if (r.intendedMediaId !== undefined && !isUuid(r.intendedMediaId)) bad('intendedMediaId');
  if (r.completed !== undefined) {
    const c = r.completed as Record<string, unknown> | null;
    if (typeof c !== 'object' || c === null || !isUuid(c.mediaId) || !isFiniteNumber(c.at)) {
      bad('completed');
    }
  }
  return r as unknown as SessionRecord;
}

/** Counts bytes through the pipe and refuses the one past the declared length. */
class PartGuard extends Transform {
  bytes = 0;
  constructor(private readonly expected: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.expected) {
      cb(new PayloadTooLargeException(`part body exceeds its declared ${this.expected} bytes`));
      return;
    }
    cb(null, chunk);
  }
}

@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly mutex = new KeyedMutex();
  private readonly dir = process.env.MEDIA_UPLOAD_SESSION_DIR
    ? path.resolve(process.env.MEDIA_UPLOAD_SESSION_DIR)
    : path.join(process.cwd(), 'upload_sessions');
  private readonly ttlMs = positiveIntEnv('MEDIA_UPLOAD_SESSION_TTL_MS', 24 * HOUR_MS);
  private readonly maxOpenPerOwner = positiveIntEnv('MEDIA_UPLOAD_SESSION_MAX_OPEN', 4);
  /** Disk the staging files may hold in total; a sparse file still reserves its declared size here. */
  private readonly maxStagedBytes = positiveIntEnv(
    'MEDIA_UPLOAD_SESSION_MAX_STAGED_BYTES',
    2 * 1024 * 1024 * 1024
  );
  /** What one member may hold staged at once, summed over their open sessions' declared sizes. */
  private readonly maxOwnerStagedBytes = positiveIntEnv(
    'MEDIA_UPLOAD_SESSION_MAX_OWNER_BYTES',
    256 * 1024 * 1024
  );
  /**
   * A session that has received NOT ONE part is held this long, not 24 h: it costs a sparse file's
   * declared size against the staging cap and a daily-budget reservation, and an opener who never
   * sends anything must not hold either for a day.
   */
  private readonly emptyTtlMs = positiveIntEnv('MEDIA_UPLOAD_SESSION_EMPTY_TTL_MS', 15 * 60 * 1000);
  private loaded?: Promise<void>;
  /** Sessions whose sidecar could not be READ (disk error): kept on disk, never swept as orphans. */
  private readonly unreadable = new Set<string>();

  constructor(
    private readonly media: MediaService,
    private readonly storage: StorageService
  ) {
    const sweepMs = positiveIntEnv('MEDIA_RETENTION_SWEEP_MS', HOUR_MS);
    const timer = setInterval(() => {
      void this.sweep().catch((err) => this.logger.error(`session sweep failed: ${String(err)}`));
    }, sweepMs);
    timer.unref();
  }

  // --- routes' operations ---------------------------------------------------------------------

  /**
   * Opens a session. Refusals are ANSWERS, typed: 400 malformed, 413 over the ceiling or over the
   * 8 MiB part invariant, 429 over the daily budget, the open-session cap or the staging budget.
   */
  async init(
    ownerId: string,
    input: {
      retentionClass?: RetentionClass;
      totalBytes: unknown;
      partBytes: unknown;
      header: unknown;
    },
    maxBytes: number
  ): Promise<{ uploadId: string; partBytes: number; totalParts: number; expiresAt: number }> {
    await this.ensureLoaded();
    const { totalBytes, partBytes } = input;
    if (!Number.isSafeInteger(totalBytes) || (totalBytes as number) <= 0) {
      throw new BadRequestException('totalBytes must be a positive integer');
    }
    if (!Number.isSafeInteger(partBytes) || (partBytes as number) < PART_MIN_BYTES) {
      throw new BadRequestException(`partBytes must be an integer of at least ${PART_MIN_BYTES}`);
    }
    const total = totalBytes as number;
    const part = partBytes as number;
    if (part > PART_MAX_BYTES) {
      this.logger.warn(`Upload session refused for ${ownerId}: partBytes ${part} over the cap`);
      throw new PayloadTooLargeException(`partBytes exceeds ${PART_MAX_BYTES} bytes`);
    }
    if (total > maxBytes) {
      this.logger.warn(`Upload session refused for ${ownerId}: ${total} bytes over ${maxBytes}`);
      throw new PayloadTooLargeException(`totalBytes exceeds ${maxBytes} bytes`);
    }
    const totalParts = partCount(total, part);
    if (totalParts > MAX_PARTS) {
      throw new BadRequestException(
        `partBytes is too small: ${totalParts} parts, max ${MAX_PARTS}`
      );
    }
    const { header } = parseDeclaredHeader(input.header);
    if (header.ciphertextLength !== total) {
      throw new BadRequestException(
        `header declares ${header.ciphertextLength} stored bytes, totalBytes is ${total}`
      );
    }

    // Sessions past their window free their staging and reservation now, not at the next sweep.
    const expiring = this.disposeExpired();
    let open = 0;
    let staged = 0;
    let ownerStaged = 0;
    for (const s of this.sessions.values()) {
      if (s.completed || expiring.has(s)) continue;
      staged += s.totalBytes;
      if (s.ownerId === ownerId) {
        open += 1;
        ownerStaged += s.totalBytes;
      }
    }
    if (ownerStaged + total > this.maxOwnerStagedBytes) {
      this.logger.warn(
        `Upload session refused for ${ownerId}: ${ownerStaged} bytes already declared, ${total} more over ${this.maxOwnerStagedBytes}`
      );
      throw new HttpException(
        'Too many bytes in open upload sessions, finish or cancel one first',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (open >= this.maxOpenPerOwner) {
      this.logger.warn(`Upload session refused for ${ownerId}: ${open} sessions already open`);
      throw new HttpException(
        `Too many open upload sessions (max ${this.maxOpenPerOwner})`,
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (staged + total > this.maxStagedBytes) {
      this.logger.warn(`Upload session refused for ${ownerId}: staging budget exhausted`);
      throw new HttpException(
        'Upload staging is full, try again later',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // Throws the 429 of the daily budget; nothing is staged yet when it does.
    const release = this.media.reserveUploadBudget(input.retentionClass, ownerId, total);
    const id = uuidv4();
    const now = Date.now();
    const session: Session = {
      id,
      ownerId,
      ...(input.retentionClass ? { retentionClass: input.retentionClass } : {}),
      totalBytes: total,
      partBytes: part,
      headerHex: (input.header as string).toLowerCase(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      received: [],
      everReceived: false,
      receivedSet: new Set(),
      release,
      aborts: new Set(),
      active: new Set(),
      completing: false,
    };
    // Registered BEFORE the awaits below: the open-session cap above was judged on this map, and two
    // concurrent inits from one member must not both pass it. The client has no id until we answer.
    this.sessions.set(id, session);
    try {
      await fs.ensureDir(this.dir);
      const handle = await fs.promises.open(this.dataPath(id), 'w');
      try {
        await handle.truncate(total);
      } finally {
        await handle.close();
      }
      await this.persist(session);
    } catch (err) {
      this.sessions.delete(id);
      release();
      await this.removeFiles(id);
      this.logger.error(`Upload session ${id} could not be staged: ${String(err)}`);
      throw new InternalServerErrorException('Could not stage the upload');
    }
    this.logger.log(
      `Upload session ${id} opened by ${ownerId}: ${total} bytes in ${totalParts} part(s) of ${part} (class=${input.retentionClass ?? 'unclassified'})`
    );
    return { uploadId: id, partBytes: part, totalParts, expiresAt: this.effectiveExpiry(session) };
  }

  /**
   * Streams one part to its offset. `contentLength` is the REQUEST's declared length: it is required
   * (411), may not exceed 8 MiB (413, before a byte is read) and must equal the part's exact length
   * (400, or 413 when larger). A part is marked received only once every byte has landed, so an
   * interrupted PUT leaves nothing the status route would report.
   */
  async putPart(
    ownerId: string,
    id: string,
    index: unknown,
    body: Readable,
    contentLength: number | undefined
  ): Promise<{ index: number; receivedCount: number }> {
    await this.ensureLoaded();
    const session = await this.requireOpen(ownerId, id);
    if (session.completing) throw new ConflictException('Upload is being completed');
    const idx = Number(index);
    const parts = partCount(session.totalBytes, session.partBytes);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parts) {
      throw new BadRequestException(`part index must be an integer in [0, ${parts - 1}]`);
    }
    if (contentLength === undefined) {
      throw new HttpException('Content-Length is required', HttpStatus.LENGTH_REQUIRED);
    }
    if (contentLength > PART_MAX_BYTES) {
      this.logger.warn(`Part ${idx} of session ${id} refused: ${contentLength} bytes over the cap`);
      throw new PayloadTooLargeException(`a part body may not exceed ${PART_MAX_BYTES} bytes`);
    }
    const expected = expectedPartLength(session.totalBytes, session.partBytes, idx);
    if (contentLength > expected) {
      throw new PayloadTooLargeException(`part ${idx} is ${expected} bytes, not ${contentLength}`);
    }
    if (contentLength !== expected) {
      throw new BadRequestException(`part ${idx} is ${expected} bytes, not ${contentLength}`);
    }

    const abort = new AbortController();
    const task = this.mutex.run(`${id}:${idx}`, async () => {
      // Re-checked under the lock: a cancel may have arrived while this waited behind a retry.
      if (!this.sessions.has(id))
        throw new NotFoundException('Upload session not found or expired');
      if (session.completing || session.completed) {
        throw new ConflictException('Upload is being completed');
      }
      // A re-sent part is REWRITTEN, and a rewrite interrupted midway leaves torn bytes at that
      // offset. So the index stops counting as received - durably - BEFORE the first byte moves,
      // and is added back only once the whole body has landed. Without this a crash or a dropped
      // retry left a "received" part that was half old, half new, and `complete` stored it.
      if (session.receivedSet.delete(idx)) {
        session.received = [...session.receivedSet].sort((a, b) => a - b);
        this.logger.log(`Part ${idx} of session ${id} re-sent: unmarked while it is rewritten`);
        await this.mutex.run(`${id}:meta`, () => this.persist(session));
      }
      const guard = new PartGuard(expected);
      const out = fs.createWriteStream(this.dataPath(id), {
        flags: 'r+',
        start: idx * session.partBytes,
        highWaterMark: WRITE_BUFFER_BYTES,
      });
      try {
        await pipeline(body, guard, out, { signal: abort.signal });
      } catch (err) {
        if (err instanceof HttpException) {
          this.logger.warn(`Part ${idx} of session ${id} refused: ${err.message}`);
          throw err;
        }
        if (abort.signal.aborted) {
          throw new ConflictException('Upload session was closed');
        }
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // The staging file is gone: the session was closed (cancel, expiry) under this write.
          this.logger.warn(`Part ${idx} of session ${id}: staging file gone, session closed`);
          throw new ConflictException('Upload session was closed');
        }
        if (code === 'ENOSPC') {
          this.logger.error(`Part ${idx} of session ${id}: the staging disk is full (ENOSPC)`);
          throw new HttpException(
            'Upload staging has no space left, try again later',
            HttpStatus.INSUFFICIENT_STORAGE
          );
        }
        if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') {
          this.logger.warn(`Part ${idx} of session ${id} interrupted after ${guard.bytes} bytes`);
          throw new BadRequestException('Part body was interrupted; send it again');
        }
        this.logger.error(`Part ${idx} of session ${id} could not be written: ${String(err)}`);
        throw new InternalServerErrorException('Could not write the part');
      }
      if (guard.bytes !== expected) {
        this.logger.warn(`Part ${idx} of session ${id}: ${guard.bytes} of ${expected} bytes`);
        throw new BadRequestException(
          `part ${idx} is ${expected} bytes, the body had ${guard.bytes}`
        );
      }
      if (!this.sessions.has(id)) {
        // Closed while the last bytes landed: the staging is gone or going, nothing to record.
        throw new ConflictException('Upload session was closed');
      }
      session.receivedSet.add(idx);
      session.everReceived = true;
      session.received = [...session.receivedSet].sort((a, b) => a - b);
      await this.mutex.run(`${id}:meta`, () => this.persist(session));
    });
    session.aborts.add(abort);
    session.active.add(task);
    try {
      await task;
    } finally {
      session.aborts.delete(abort);
      session.active.delete(task);
    }
    return { index: idx, receivedCount: session.receivedSet.size };
  }

  /** The server's fact: which parts it holds. Also answers a completed session with its memo. */
  async status(
    ownerId: string,
    id: string
  ): Promise<{
    totalBytes: number;
    partBytes: number;
    totalParts: number;
    received: number[];
    expiresAt: number;
    mediaId?: string;
  }> {
    await this.ensureLoaded();
    const session = await this.require(ownerId, id);
    return {
      totalBytes: session.totalBytes,
      partBytes: session.partBytes,
      totalParts: partCount(session.totalBytes, session.partBytes),
      received: [...session.received],
      expiresAt: this.effectiveExpiry(session),
      ...(session.completed ? { mediaId: session.completed.mediaId } : {}),
    };
  }

  /**
   * Assembles and registers the blob. Every part present, size exact, header equal to the declared
   * one (409 / 422 otherwise); a repeat returns the same `mediaId`. The reservation is released in
   * the run that registers the entry, or when the session ends some other way - never twice.
   */
  async complete(ownerId: string, id: string): Promise<{ mediaId: string }> {
    await this.ensureLoaded();
    return this.mutex.run(`${id}:complete`, async () => {
      const session = await this.require(ownerId, id);
      if (session.completed) {
        this.logger.log(
          `Upload session ${id} completed again: same media ${session.completed.mediaId}`
        );
        return { mediaId: session.completed.mediaId };
      }
      if (session.active.size > 0) {
        throw new ConflictException('Parts are still being received');
      }
      // Set in the same synchronous run as the check above: a PUT arriving from here on is refused
      // (409) instead of writing into, or racing the removal of, the file being stored.
      session.completing = true;
      try {
        return await this.assemble(ownerId, session);
      } finally {
        session.completing = false;
      }
    });
  }

  /** The body of `complete`, run under its lock with `completing` set. */
  private async assemble(ownerId: string, session: Session): Promise<{ mediaId: string }> {
    const id = session.id;
    {
      const parts = partCount(session.totalBytes, session.partBytes);
      if (session.receivedSet.size !== parts) {
        const missing = parts - session.receivedSet.size;
        this.logger.warn(
          `Upload session ${id} cannot complete: ${missing} of ${parts} part(s) missing`
        );
        throw new ConflictException(`${missing} of ${parts} part(s) are missing`);
      }
      const dataPath = this.dataPath(id);
      const stat = await fs.stat(dataPath);
      if (stat.size !== session.totalBytes) {
        this.logger.error(
          `Upload session ${id}: staged ${stat.size} bytes, declared ${session.totalBytes}`
        );
        throw new ConflictException('Staged size differs from the declared total');
      }
      const first = Buffer.alloc(SEGMENTED_HEADER_BYTES);
      const handle = await fs.promises.open(dataPath, 'r');
      try {
        await handle.read(first, 0, SEGMENTED_HEADER_BYTES, 0);
      } finally {
        await handle.close();
      }
      if (first.toString('hex') !== session.headerHex) {
        this.logger.warn(`Upload session ${id}: staged header differs from the declared one`);
        throw new UnprocessableEntityException('Staged header differs from the declared header');
      }

      // Durable BEFORE the store is touched, so a crash from here on retries into the same key.
      if (!session.intendedMediaId) {
        session.intendedMediaId = uuidv4();
        await this.mutex.run(`${id}:meta`, () => this.persist(session));
      }
      const mediaId = session.intendedMediaId;
      try {
        await this.storage.putFileStream(mediaId, dataPath, session.totalBytes);
      } catch (err) {
        // The session stays open and keeps its reservation: `complete` may be retried.
        this.logger.error(`Upload session ${id}: the store refused ${mediaId}: ${String(err)}`);
        throw new InternalServerErrorException('Could not store the upload');
      }
      await this.media.registerUpload(
        mediaId,
        ownerId,
        session.retentionClass,
        session.totalBytes,
        session.release
      );
      session.release();
      session.completed = { mediaId, at: Date.now() };
      // The memo lives a full window from now, so a client whose answer was lost can still ask.
      session.expiresAt = Math.max(session.expiresAt, session.completed.at + this.ttlMs);
      try {
        await this.mutex.run(`${id}:meta`, () => this.persist(session));
      } catch (err) {
        // The object is stored and registered: the member is told so. Only the memo is not durable,
        // and the staging file is KEPT so a restart retries `complete` into the same media id.
        this.logger.error(
          `Upload session ${id}: media ${mediaId} registered but its memo was not persisted: ${String(err)}`
        );
        return { mediaId };
      }
      await fs.remove(dataPath).catch((err) => {
        this.logger.warn(`Upload session ${id}: staged file not removed: ${String(err)}`);
      });
      this.logger.log(`Upload session ${id} completed -> ${mediaId} (${session.totalBytes} bytes)`);
      return { mediaId };
    }
  }

  /** Cancels now: aborts in-flight parts, deletes the staging, releases the reservation. */
  async cancel(ownerId: string, id: string): Promise<void> {
    await this.ensureLoaded();
    const session = await this.require(ownerId, id);
    // Under the same lock as `complete`: a staging file is never removed while the store reads it.
    // Both facts are re-read INSIDE it: a `complete` that held the lock may have finished (a
    // completed upload is not cancellable) and an expiry may have disposed the session meanwhile.
    await this.mutex.run(`${id}:complete`, async () => {
      if (session.completed) throw new ConflictException('Upload already completed');
      if (!this.sessions.has(id)) {
        throw new NotFoundException('Upload session not found or expired');
      }
      await this.dispose(session, 'cancelled');
    });
  }

  /** Removes every expired session (and the memo of an expired completion). */
  async sweep(): Promise<number> {
    await this.ensureLoaded();
    const now = Date.now();
    let swept = 0;
    for (const session of this.sessions.values()) {
      if (this.effectiveExpiry(session) <= now) {
        await this.expire(session);
        swept += 1;
      }
    }
    // Staging files no session claims (a sidecar lost, a crash between the two writes).
    try {
      for (const name of await fs.readdir(this.dir)) {
        const id = name.replace(/\.(data|json\.tmp|json)$/, '');
        if (!this.sessions.has(id) && !this.unreadable.has(id) && UUID_REGEX.test(id)) {
          await this.removeFiles(id);
          swept += 1;
          this.logger.warn(`Upload staging for unknown session ${id} removed`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`Upload session sweep could not list ${this.dir}: ${String(err)}`);
      }
    }
    if (swept > 0) this.logger.log(`Upload session sweep removed ${swept} session(s)`);
    return swept;
  }

  // --- internals ------------------------------------------------------------------------------

  /** Loads the sessions a previous process left, once; their reservations are put back, not re-judged. */
  private ensureLoaded(): Promise<void> {
    return (this.loaded ??= this.load().catch((err) => {
      this.loaded = undefined;
      this.logger.error(`Upload sessions could not be loaded: ${String(err)}`);
      throw new InternalServerErrorException('Upload sessions unavailable');
    }));
  }

  private async load(): Promise<void> {
    await fs.ensureDir(this.dir);
    let restored = 0;
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!UUID_REGEX.test(id)) continue;
      let record: SessionRecord;
      try {
        record = validateRecord(await fs.readJson(path.join(this.dir, name)), id);
        if (!record.completed) {
          const stat = await fs.stat(this.dataPath(id));
          if (stat.size !== record.totalBytes) throw new InvalidRecordError('staging size differs');
        }
      } catch (err) {
        const wrong =
          err instanceof InvalidRecordError ||
          err instanceof SyntaxError ||
          (err as NodeJS.ErrnoException)?.code === 'ENOENT';
        if (!wrong) {
          // The DISK failed (EIO, EACCES, EMFILE...), not the record: deleting here would destroy a
          // member's upload for a fault that may be gone in a minute. Keep it, shield it from the
          // orphan sweep, and say so.
          this.unreadable.add(id);
          this.logger.error(`Upload session ${id} could not be read, kept on disk: ${String(err)}`);
          continue;
        }
        this.logger.warn(`Upload session ${id} is not a valid session, removed: ${String(err)}`);
        await this.removeFiles(id);
        continue;
      }
      const set = new Set(record.received);
      const session: Session = {
        ...record,
        // A sidecar written before the flag existed: the received list is then the only evidence.
        everReceived: record.everReceived === true || set.size > 0,
        received: [...set].sort((a, b) => a - b),
        receivedSet: set,
        release: () => {},
        aborts: new Set(),
        active: new Set(),
        completing: false,
      };
      if (!session.completed) {
        session.release = this.media.reserveUploadBudget(
          session.retentionClass,
          session.ownerId,
          session.totalBytes,
          true
        );
      }
      this.sessions.set(id, session);
      restored += 1;
    }
    if (restored > 0) this.logger.log(`Restored ${restored} upload session(s) after a restart`);
  }

  /** The session if the caller owns it; 404 when unknown or past its window, 403 for another member. */
  private async require(ownerId: string, id: string): Promise<Session> {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('Invalid uploadId');
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('Upload session not found or expired');
    if (session.ownerId !== ownerId) {
      this.logger.warn(`Upload session ${id} addressed by another member than its opener`);
      throw new ForbiddenException('Not your upload session');
    }
    if (this.effectiveExpiry(session) <= Date.now()) {
      // Not awaited: this may be running inside the lock the disposal needs.
      void this.expire(session).catch((err) =>
        this.logger.error(`Expiry of session ${id} failed: ${String(err)}`)
      );
      throw new NotFoundException('Upload session not found or expired');
    }
    return session;
  }

  /**
   * When the session stops being served: the 24 h window, or the short one while it is UNTOUCHED -
   * no part ever received (durable flag) and none in flight. A first part still arriving, or a
   * received one being re-sent, is activity: the short window must not abort that write.
   */
  private effectiveExpiry(session: Session): number {
    if (
      session.completed ||
      session.everReceived ||
      session.receivedSet.size > 0 ||
      session.active.size > 0
    ) {
      return session.expiresAt;
    }
    return Math.min(session.expiresAt, session.createdAt + this.emptyTtlMs);
  }

  private expire(session: Session): Promise<void> {
    return this.mutex.run(`${session.id}:complete`, async () => {
      // Re-judged under the lock: a `complete` that held it may have finished (memo, longer window)
      // or the session may be gone, and this call waited behind it with a stale verdict.
      if (this.sessions.get(session.id) !== session) return;
      if (this.effectiveExpiry(session) > Date.now()) {
        this.logger.log(`Upload session ${session.id} no longer expired once the lock was taken`);
        return;
      }
      await this.dispose(session, 'expired');
    });
  }

  /**
   * Starts the disposal of every expired session WITHOUT waiting: one behind a long `complete` must
   * not hold every other member's `init`. Returns the sessions it is disposing, so the caller does
   * not count them against its caps.
   */
  private disposeExpired(): Set<Session> {
    const now = Date.now();
    const going = new Set<Session>();
    for (const session of this.sessions.values()) {
      if (this.effectiveExpiry(session) > now) continue;
      going.add(session);
      void this.expire(session).catch((err) =>
        this.logger.error(`Expiry of session ${session.id} failed: ${String(err)}`)
      );
    }
    return going;
  }

  private async requireOpen(ownerId: string, id: string): Promise<Session> {
    const session = await this.require(ownerId, id);
    if (session.completed) throw new ConflictException('Upload already completed');
    return session;
  }

  /** Ends a session: in-flight parts aborted and awaited, reservation released, files removed. */
  private async dispose(session: Session, why: 'cancelled' | 'expired'): Promise<void> {
    this.sessions.delete(session.id);
    try {
      for (const abort of session.aborts) abort.abort();
      await Promise.allSettled(session.active);
    } finally {
      session.release();
      await this.removeFiles(session.id);
    }
    this.logger.log(`Upload session ${session.id} ${why}`);
  }

  private async removeFiles(id: string): Promise<void> {
    for (const file of [this.dataPath(id), this.metaPath(id), `${this.metaPath(id)}.tmp`]) {
      await fs.remove(file).catch((err) => {
        this.logger.warn(`Upload staging ${file} not removed: ${String(err)}`);
      });
    }
  }

  /** Atomic: written beside, then renamed over, so a crash never leaves half a sidecar. */
  private async persist(session: Session): Promise<void> {
    const record: SessionRecord = {
      id: session.id,
      ownerId: session.ownerId,
      ...(session.retentionClass ? { retentionClass: session.retentionClass } : {}),
      totalBytes: session.totalBytes,
      partBytes: session.partBytes,
      headerHex: session.headerHex,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      received: session.received,
      everReceived: session.everReceived === true || session.received.length > 0,
      ...(session.intendedMediaId ? { intendedMediaId: session.intendedMediaId } : {}),
      ...(session.completed ? { completed: session.completed } : {}),
    };
    const tmp = `${this.metaPath(session.id)}.tmp`;
    await fs.writeJson(tmp, record);
    await fs.move(tmp, this.metaPath(session.id), { overwrite: true });
  }

  private dataPath(id: string): string {
    return this.confined(`${id}.data`, id);
  }

  private metaPath(id: string): string {
    return this.confined(`${id}.json`, id);
  }

  /** Confines a path under the session directory (the id is a UUID, checked, and the result resolved). */
  private confined(file: string, id: string): string {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('Invalid uploadId');
    const resolved = path.resolve(this.dir, file);
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new BadRequestException('Invalid upload path');
    }
    return resolved;
  }
}

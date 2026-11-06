/**
 * THE DURABLE HALF OF THE BACKGROUND PUBLISH QUEUE (owner, 2026-11-06): a post the member pressed
 * "Publier" on lives HERE until the server holds it, so a reload, a kill or a phone that suspended
 * the app never loses it - `docs/wiki/frontend/modules/posts.md#the-background-publish-queue`.
 *
 * ONE DATABASE PER ACCOUNT, `CanariDBPublish_<userId>`. Its own database rather than a store of the
 * message store's (`CanariDB_<userId>` does not exist on a phone, whose messages are SQLite), and
 * the `CanariDB` prefix is what the device wipe enumerates, so a reset removes it with the rest. The
 * connection CLOSES ITSELF on `versionchange`, which is the event a `deleteDatabase` raises: the
 * wipe's delete never blocks on it, with no close step the wipe has to remember.
 *
 * NOT SEALED BY THE DEVICE KEY, deliberately: it holds what the composer draft already holds in the
 * clear (`postComposerDraft.ts`, localStorage) plus the media the member chose, and the CEK of an
 * upload in progress - which the post row on the server carries anyway (a post's media key is not
 * end-to-end). So it is not a `SealedStore` and a PIN change has nothing to re-seal here.
 *
 * TWO STORES, WRITTEN TOGETHER. `posts` holds one small record per queued post (the payload and each
 * media's progress: prepared, the resumable session, the uploaded ref); `files` holds the bytes, one
 * record per media, keyed `<postId>/<index>`. A record and its bytes change in ONE transaction, so
 * the original file and the prepared one are never both - or neither - what the record names.
 */
import type { CreatePostPayload, PostFeed, PostMediaRef } from '$lib/posts/api';
import type { OutboxResumableUpload } from '$lib/db/types';
import { appendLog } from '$lib/utils/sessionLog';

const DB_PREFIX = 'CanariDBPublish_';
const DB_VERSION = 1;
const POSTS = 'posts';
const FILES = 'files';

/** One media of a queued post, in the post's order. */
export interface QueuedMedia {
  /** The name, type and size of the file the member CHOSE (shown while it is prepared). */
  name: string;
  type: string;
  size: number;
  caption?: string;
  /**
   * Set once the file was prepared (a photo compressed, a video re-encoded): the bytes in `files`
   * are then the PREPARED ones, and they are never prepared again - an encoder is not bit-exact, and
   * the resumable session is bound to the bytes it was opened for.
   */
  prepared?: { name: string; type: string; size: number; width?: number; height?: number };
  /** The resumable session of this media's upload, written before its first part leaves. */
  upload?: OutboxResumableUpload;
  /** Set once the server holds the blob: the ref the post carries. Never uploaded again. */
  ref?: PostMediaRef;
}

/** Why a queued post stopped for good until the member acts: a sentence and the stage it stopped at. */
export interface QueuedPostFailure {
  stage: 'moderation' | 'mediaPrepare' | 'mediaUpload' | 'createPost';
  /** The sentence shown, in the member's language at the time it failed. */
  message: string;
}

/** One post waiting to be published. */
export interface QueuedPost {
  /** The post's id, minted at the press: the server stores the post under it (`post-client-id.ts`). */
  id: string;
  /** Orders the queue: the posts go in the order they were published. */
  queuedAt: number;
  /** Everything the post carries but its media. */
  payload: Omit<CreatePostPayload, 'media' | 'images'>;
  media: QueuedMedia[];
  /** The feed the post lands in (`landingFeedFor`), for the page that shows it once published. */
  landing: PostFeed | null;
  /** Set when the post stopped for good; cleared by a retry. Absent: the queue works on it. */
  failure?: QueuedPostFailure;
}

/** The bytes of one media. */
export interface QueuedFile {
  bytes: ArrayBuffer;
  name: string;
  type: string;
}

/** A record the store holds that names bytes it does not hold: a typed, visible failure. */
export class QueuedFileMissingError extends Error {
  constructor(postId: string, index: number) {
    super(`the media ${index} of queued post ${postId} is no longer stored on this device`);
    this.name = 'QueuedFileMissingError';
  }
}

const fileKey = (postId: string, index: number) => `${postId}/${index}`;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves when the transaction COMMITS, rejecting with the request's own error first. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: unknown = null;
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => {
      failure ??= (e.target as IDBRequest | null)?.error ?? tx.error;
    };
    tx.onabort = () =>
      reject(failure ?? tx.error ?? new Error('publish queue transaction aborted'));
  });
}

/** The queue's durable store for one account. */
export class PublishQueueStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(readonly userId: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`${DB_PREFIX}${this.userId}`, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(POSTS)) db.createObjectStore(POSTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      };
      req.onsuccess = () => {
        const db = req.result;
        // A `deleteDatabase` (the device wipe) asks every connection to go: this one does, so the
        // delete completes instead of blocking on it.
        db.onversionchange = () => {
          appendLog('[PUBLISH-QUEUE] store closed: the database is being deleted');
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.db = null;
        reject(req.error);
      };
    });
    return this.db;
  }

  /**
   * Queues a post and its files in ONE transaction: either the post and every byte it names are on
   * the device, or nothing is. The files are read BEFORE the transaction opens, because an IndexedDB
   * transaction commits on its own as soon as it waits on anything else.
   */
  async enqueue(post: QueuedPost, files: File[]): Promise<void> {
    const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
    const db = await this.open();
    const tx = db.transaction([POSTS, FILES], 'readwrite');
    const done = committed(tx);
    tx.objectStore(POSTS).put(post);
    files.forEach((f, i) => {
      const record: QueuedFile = { bytes: buffers[i], name: f.name, type: f.type };
      tx.objectStore(FILES).put(record, fileKey(post.id, i));
    });
    await done;
  }

  /** Every queued post, oldest first. */
  async list(): Promise<QueuedPost[]> {
    const db = await this.open();
    const all = (await request(
      db.transaction(POSTS, 'readonly').objectStore(POSTS).getAll()
    )) as QueuedPost[];
    return all.sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  }

  /** One queued post, or `null` once it is gone (published or deleted). */
  async get(postId: string): Promise<QueuedPost | null> {
    const db = await this.open();
    const row = await request(db.transaction(POSTS, 'readonly').objectStore(POSTS).get(postId));
    return (row as QueuedPost | undefined) ?? null;
  }

  /**
   * The bytes of media `index`.
   *
   * @throws QueuedFileMissingError when the record is there and its bytes are not.
   */
  async readFile(postId: string, index: number): Promise<QueuedFile> {
    const db = await this.open();
    const file = (await request(
      db.transaction(FILES, 'readonly').objectStore(FILES).get(fileKey(postId, index))
    )) as QueuedFile | undefined;
    if (!file) throw new QueuedFileMissingError(postId, index);
    return file;
  }

  /**
   * Writes the record - only if it is still queued: a post the member deleted while a step was
   * running stays deleted. With `bytes`, the media's bytes are replaced in the SAME transaction
   * (the prepared file takes the place of the original the moment the record says so).
   *
   * @returns `false` when the post is no longer queued and nothing was written.
   */
  async update(post: QueuedPost, bytes?: { index: number; file: QueuedFile }): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction([POSTS, FILES], 'readwrite');
    const done = committed(tx);
    const posts = tx.objectStore(POSTS);
    let written = false;
    const read = posts.get(post.id);
    read.onsuccess = () => {
      if (!read.result) return;
      written = true;
      posts.put(post);
      if (bytes) tx.objectStore(FILES).put(bytes.file, fileKey(post.id, bytes.index));
    };
    await done;
    return written;
  }

  /** Removes a post and every byte it named (published, or deleted by the member). */
  async remove(postId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([POSTS, FILES], 'readwrite');
    const done = committed(tx);
    tx.objectStore(POSTS).delete(postId);
    tx.objectStore(FILES).delete(IDBKeyRange.bound(`${postId}/`, `${postId}/￿`));
    await done;
  }

  /** Closes the connection (sign-out); the next call opens it again. */
  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (db) (await db.catch(() => null))?.close();
  }
}

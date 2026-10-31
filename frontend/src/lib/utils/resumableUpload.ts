/**
 * THE RESUMABLE UPLOAD OF A CHAT REEL (reels-in-chat RC-5) - the client half of media-service's
 * upload sessions (`/api/media/upload/session`, WP-S1, docs/wiki/services/media-streaming-upload.md).
 *
 * WHAT IT REPLACES, FOR A REEL. `encryptAndUpload` seals the whole file, then sends it as one body or
 * as legacy chunks under a FRESH uploadId per attempt: a cut at 90 % restarts from byte 0, and nothing
 * says how many bytes the server holds. Here the SERVER says which parts it holds (`GET`), and only
 * the missing ones are sent - a fact the server reports, never a guess by the client.
 *
 * WHY A RE-SENT PART IS THE SAME BYTES. The blob is `segmented-v1` (`mediaSegmented.ts`): segment `i`
 * is sealed under the CEK with the nonce `iv[0..7] || be32(i) || last`. Sealing the same plaintext
 * under the same CEK and IV yields the same bytes, so a part may be re-sealed and re-sent after a
 * crash with NO nonce-reuse risk - provided the PLAINTEXT is the same. That proviso is enforced, not
 * assumed: the state carries the SHA-256 of the plaintext it was opened for, and a state whose digest
 * differs from the bytes being uploaded is discarded (fresh CEK, fresh session). Without it a
 * re-prepared take - an encoder is not bit-exact across runs - would be sealed under a used nonce.
 *
 * WHAT IS PERSISTED, AND WHERE. {@link ResumableUploadState} - the CEK, the IV, the session id - is
 * handed to the caller's `persist`, which writes it into the ENCRYPTED outbox row: the row and its
 * blob hold the file itself, so the key adds no exposure the row did not already carry.
 *
 * Every request body is one part, {@link REEL_UPLOAD_PART_BYTES} (1 MiB): under the host WAF's 10 MiB
 * drop and the 8 MiB budget, and the most a cut on a weak link can cost.
 */
import {
  SEGMENTED_MEDIA_ENCODING,
  SEGMENTED_MEDIA_HEADER_BYTES,
  SEGMENTED_MEDIA_SEGMENT_BYTES,
  SEGMENT_TAG_BYTES,
  encodeSegmentedHeader,
  segmentNonce,
  segmentedCiphertextLength,
} from '$lib/mediaSegmented';
import { generateMediaCek, generateMediaIv, hexDecode, hexEncode } from '$lib/mediaCrypto';
import { MEDIA_REQUEST_BODY_BUDGET_BYTES } from '$lib/utils/mediaRequestLimits';
import { uploadRefusalCause, uploadRefusalFrom } from '$lib/utils/mediaErrors';
import { responseOrigin } from '$lib/utils/apiRefusal';
import { UploadAbortedError, type XhrUploadOptions } from '$lib/utils/uploadXhr';
import { isTransportFailure } from '$lib/utils/transportFailure';
import type { MediaRetentionClass } from '$lib/media';
import type { OutboxResumableUpload } from '$lib/db/types';

/**
 * One request body. 1 MiB, not the 4 MiB the streaming design proposed: a cut on a weak uplink
 * costs at most this much again, and it stays under every body limit on the way (the host WAF drops
 * over 10 MiB; a legacy relay refused over 1 MiB - `<=` passes). 50 parts at the 50 MB ceiling, far
 * under the server's 4096.
 */
export const REEL_UPLOAD_PART_BYTES = 1024 * 1024;

/** How many times one call re-reads the server's fact before giving the failure to its caller. */
export const RESUMABLE_MAX_ROUNDS = 3;

/** What survives a kill - the outbox row's `media.upload` (see the module comment for the digest). */
export type ResumableUploadState = OutboxResumableUpload;

/** How a request reaches media-service: the production one is `MediaService`'s, a test's a fake server. */
export interface ResumableUploadPort {
  /**
   * Sends one request to `/api/media/upload/session<path>`. JSON bodies are strings; a part is a
   * `Blob` and gets the transport (progress, cancel, stall guard). Resolves with whatever status the
   * server answered; rejects only when NO answer came (a transport failure, a cancel).
   */
  request(
    method: 'POST' | 'PUT' | 'GET' | 'DELETE',
    path: string,
    body: Blob | string | null,
    transport?: XhrUploadOptions
  ): Promise<Response>;
}

export interface ResumableUploadOptions {
  /** The plaintext to upload (the prepared video). */
  plaintext: Uint8Array;
  retentionClass: MediaRetentionClass;
  /** What a previous attempt persisted, if any. */
  state?: ResumableUploadState;
  /**
   * Writes the state durably. Called once the session exists, BEFORE its first part leaves. A
   * failure is the caller's to log; the upload goes on (the cost of a lost write is one re-upload
   * after a kill, never a wrong byte - the digest guards that).
   */
  persist: (state: ResumableUploadState) => Promise<void>;
  port: ResumableUploadPort;
  /** Progress (whole blob), cancel and stall guard for each part. */
  transport?: XhrUploadOptions;
  log: (line: string) => void;
  /**
   * The part size to ask for; {@link REEL_UPLOAD_PART_BYTES} when absent. The server checks it
   * (1 KiB to 8 MiB) and echoes it; a test asks for small parts so a small file has several.
   */
  partBytes?: number;
}

/** What the upload produced: the ref fields the message carries. */
export interface ResumableUploadResult {
  mediaId: string;
  keyHex: string;
  ivHex: string;
  encoding: typeof SEGMENTED_MEDIA_ENCODING;
}

/** The server's answer to `GET /session/:id`. */
interface SessionStatus {
  totalBytes: number;
  partBytes: number;
  totalParts: number;
  received: number[];
  mediaId?: string;
}

/** SHA-256 of `bytes`, hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return hexEncode(new Uint8Array(digest));
}

/** An encrypt-capable CEK (the shared importer is decrypt-only, for readers). */
function importSealingKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexDecode(keyHex),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
}

/**
 * Seals byte range `[start, end)` of the segmented blob of `plaintext` - the header, then whichever
 * sealed segments the range overlaps - holding only those segments in memory, never the whole blob.
 * Deterministic: the same inputs give the same bytes, which is what makes a re-sent part harmless.
 */
export async function sealBlobRange(
  plaintext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
  start: number,
  end: number
): Promise<Uint8Array<ArrayBuffer>> {
  const seg = SEGMENTED_MEDIA_SEGMENT_BYTES;
  const sealedSeg = seg + SEGMENT_TAG_BYTES;
  const header = encodeSegmentedHeader(seg, plaintext.byteLength);
  const count = Math.max(1, Math.ceil(plaintext.byteLength / seg));
  const out = new Uint8Array(end - start);
  let written = 0;
  if (start < SEGMENTED_MEDIA_HEADER_BYTES) {
    const h = header.subarray(start, Math.min(end, SEGMENTED_MEDIA_HEADER_BYTES));
    out.set(h, 0);
    written += h.byteLength;
  }
  const bodyStart = Math.max(start, SEGMENTED_MEDIA_HEADER_BYTES) - SEGMENTED_MEDIA_HEADER_BYTES;
  const bodyEnd = end - SEGMENTED_MEDIA_HEADER_BYTES;
  if (bodyEnd <= bodyStart) return out;
  const first = Math.floor(bodyStart / sealedSeg);
  const last = Math.min(count - 1, Math.floor((bodyEnd - 1) / sealedSeg));
  for (let i = first; i <= last; i++) {
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: segmentNonce(iv, i, i === count - 1), additionalData: header },
        key,
        plaintext.subarray(i * seg, Math.min((i + 1) * seg, plaintext.byteLength)) as BufferSource
      )
    );
    const segAt = i * sealedSeg;
    const from = Math.max(bodyStart, segAt) - segAt;
    const to = Math.min(bodyEnd, segAt + sealed.byteLength) - segAt;
    out.set(sealed.subarray(from, to), written);
    written += to - from;
  }
  return out;
}

/**
 * Gives an open session (its staged parts, its slot among the owner's open sessions, its budget)
 * back to the server: `DELETE /session/:id`. Best effort and logged either way - the server's sweep
 * (24 h) is what holds when it cannot be reached. Never throws.
 */
export async function releaseUploadSession(
  port: ResumableUploadPort,
  uploadId: string,
  why: string,
  log: (line: string) => void
): Promise<void> {
  try {
    const res = await port.request('DELETE', `/${uploadId}`, null);
    log(`[UPLOAD-RESUME] session ${uploadId} released (${why}): HTTP ${res.status}`);
  } catch (e) {
    log(
      `[UPLOAD-RESUME] session ${uploadId} NOT released (${why}), the server's sweep holds it: ${String(e)}`
    );
  }
}

/**
 * The SERVER said this session is gone (404) or not in a state to take this request (409) - read
 * from the answer's ORIGIN as well as its status: a non-JSON 404/409 is the edge or a proxy speaking
 * (a deploy, a restart), which says nothing about the session and is retried like any edge answer.
 */
function sessionAnswered(res: Response, ...statuses: number[]): boolean {
  return statuses.includes(res.status) && responseOrigin(res) === 'gateway';
}

/**
 * Uploads `plaintext` as a `segmented-v1` blob through a resumable session, resuming what `state`
 * names. NO PART THE SERVER HOLDS IS SENT AGAIN, and a session the server already completed is
 * answered from its memo without a byte (a kill between `complete` and the ref's write).
 *
 * Throws what the outbox already classifies: a `MediaUploadError` for an answer (typed at the throw,
 * `sessionLost` when the session is gone and could not be reopened within {@link RESUMABLE_MAX_ROUNDS}),
 * a transport failure as the transport threw it, `UploadAbortedError` on any abort. Only a refusal
 * for good releases the session here; anything else keeps it for the next call, and a withdrawal
 * releases it through {@link releaseUploadSession}.
 */
export async function uploadResumable(
  opts: ResumableUploadOptions
): Promise<ResumableUploadResult> {
  const { plaintext, port, log, transport, retentionClass } = opts;
  const digest = await sha256Hex(plaintext);
  let state = opts.state;
  if (
    state &&
    (state.plaintextSha256 !== digest || state.plaintextBytes !== plaintext.byteLength)
  ) {
    // A state opened for OTHER bytes (a re-prepared take): resealing under its nonces would reuse
    // them with a different plaintext. Never resumed; a new key and a new session.
    log(
      `[UPLOAD-RESUME] the saved session was opened for other bytes (${state.plaintextBytes} vs ${plaintext.byteLength}) - discarded, a new key and session`
    );
    state = undefined;
  }
  if (!state) {
    const { keyHex } = await generateMediaCek();
    const { ivHex } = generateMediaIv();
    state = { keyHex, ivHex, plaintextSha256: digest, plaintextBytes: plaintext.byteLength };
  }
  const key = await importSealingKey(state.keyHex);
  const iv = hexDecode(state.ivHex);
  const totalBytes = segmentedCiphertextLength(plaintext.byteLength);
  const header = encodeSegmentedHeader(SEGMENTED_MEDIA_SEGMENT_BYTES, plaintext.byteLength);

  const answer = async (res: Response, what: string, sessionLost = false) => {
    throw await uploadRefusalFrom(res, what, { sessionLost });
  };

  /** Opens a session for these bytes; persists the state before any part leaves. */
  const open = async (): Promise<void> => {
    const res = await port.request(
      'POST',
      '',
      JSON.stringify({
        retentionClass,
        totalBytes,
        partBytes: opts.partBytes ?? REEL_UPLOAD_PART_BYTES,
        header: hexEncode(header),
      }),
      transport && { signal: transport.signal }
    );
    if (!res.ok) await answer(res, 'upload session init failed');
    const body = (await res.json()) as { uploadId?: unknown; partBytes?: unknown };
    if (typeof body.uploadId !== 'string' || typeof body.partBytes !== 'number') {
      throw new Error('[UPLOAD-RESUME] init answered no uploadId/partBytes');
    }
    state = { ...state!, uploadId: body.uploadId, partBytes: body.partBytes };
    log(`[UPLOAD-RESUME] session ${body.uploadId} opened: ${totalBytes} bytes`);
    await opts.persist(state);
  };

  /** The server's fact for the current session, or `null` when it no longer has it (404). */
  const status = async (): Promise<SessionStatus | null> => {
    const res = await port.request(
      'GET',
      `/${state!.uploadId}`,
      null,
      transport && { signal: transport.signal }
    );
    if (sessionAnswered(res, 404)) return null;
    if (!res.ok) await answer(res, 'upload session status failed');
    return (await res.json()) as SessionStatus;
  };

  const release = (why: string) => {
    const id = state?.uploadId;
    // Never awaited by the failure it follows: the server's sweep is the backstop.
    if (id) void releaseUploadSession(port, id, why, log);
  };

  try {
    for (let round = 1; ; round++) {
      let received = new Set<number>();
      if (state.uploadId) {
        const fact = await status();
        if (fact?.mediaId) {
          log(`[UPLOAD-RESUME] session ${state.uploadId} was already completed: no byte re-sent`);
          return {
            mediaId: fact.mediaId,
            keyHex: state.keyHex,
            ivHex: state.ivHex,
            encoding: SEGMENTED_MEDIA_ENCODING,
          };
        }
        if (!fact || fact.totalBytes !== totalBytes || fact.partBytes !== state.partBytes) {
          // Gone (the 24 h window, the 15 min empty one, a cancel) or not ours to resume: the same
          // key, a new session - every part again, said once, since it is the costly branch.
          log(
            `[UPLOAD-RESUME] session ${state.uploadId} ${fact ? 'does not match these bytes' : 'is gone on the server'} - reopening, every part again`
          );
          state = { ...state, uploadId: undefined, partBytes: undefined };
        } else {
          received = new Set(fact.received);
          log(
            `[UPLOAD-RESUME] session ${state.uploadId} resumed: the server holds ${received.size}/${fact.totalParts} part(s)`
          );
        }
      }
      if (!state.uploadId) await open();
      const partBytes = state.partBytes!;
      const parts = Math.ceil(totalBytes / partBytes);
      if (partBytes > MEDIA_REQUEST_BODY_BUDGET_BYTES) {
        throw new Error(`[UPLOAD-RESUME] a part of ${partBytes} bytes is over the body budget`);
      }
      let held = [...received].reduce(
        (sum, i) => sum + Math.min(partBytes, totalBytes - i * partBytes),
        0
      );
      transport?.onProgress?.({ loaded: held, total: totalBytes });
      let reread = false;
      for (let i = 0; i < parts; i++) {
        if (received.has(i)) continue;
        const start = i * partBytes;
        const end = Math.min(totalBytes, start + partBytes);
        const body = await sealBlobRange(plaintext, key, iv, start, end);
        const base = held;
        const res = await port.request(
          'PUT',
          `/${state.uploadId}/parts/${i}`,
          new Blob([body], { type: 'application/octet-stream' }),
          transport && {
            ...transport,
            onProgress: (p) =>
              transport.onProgress?.({ loaded: base + p.loaded, total: totalBytes }),
          }
        );
        if (sessionAnswered(res, 404, 409)) {
          // Closed under us (expired, cancelled elsewhere) or being completed: re-read the fact.
          log(`[UPLOAD-RESUME] part ${i} answered ${res.status} - re-reading the session`);
          reread = true;
          break;
        }
        if (!res.ok) await answer(res, `upload part ${i + 1}/${parts} failed`);
        held += end - start;
        received.add(i);
      }
      if (!reread) {
        const res = await port.request(
          'POST',
          `/${state.uploadId}/complete`,
          null,
          transport && { signal: transport.signal }
        );
        if (res.ok) {
          const { mediaId } = (await res.json()) as { mediaId?: unknown };
          if (typeof mediaId !== 'string')
            throw new Error('[UPLOAD-RESUME] complete answered no mediaId');
          log(`[UPLOAD-RESUME] session ${state.uploadId} completed -> ${mediaId}`);
          return {
            mediaId,
            keyHex: state.keyHex,
            ivHex: state.ivHex,
            encoding: SEGMENTED_MEDIA_ENCODING,
          };
        }
        if (!sessionAnswered(res, 404, 409)) await answer(res, 'upload session complete failed');
        log(`[UPLOAD-RESUME] complete answered ${res.status} - re-reading the session`);
      }
      if (round >= RESUMABLE_MAX_ROUNDS) {
        throw await uploadRefusalFrom(
          new Response(null, { status: 404 }),
          `upload session could not be completed in ${RESUMABLE_MAX_ROUNDS} rounds`,
          { sessionLost: true }
        );
      }
    }
  } catch (e) {
    // A REFUSAL FOR GOOD ends this upload: give the session (and its budget) back now. Anything
    // else - no answer, a 5xx, an edge page, a local failure, any abort - keeps it. AN ABORT IS NOT A
    // WITHDRAWAL: a teardown aborts too, and its row resumes at the next launch. The member's
    // withdrawal releases the session itself, from the id it reads in the row ({@link
    // releaseUploadSession}), which covers the entries with no transfer running to abort.
    // Decided by type (`uploadRefusalCause` reads status and origin).
    const cause = e instanceof UploadAbortedError ? null : uploadRefusalCause(e);
    if (cause) release(`refused: ${cause}`);
    else
      log(
        `[UPLOAD-RESUME] attempt ended (${e instanceof Error ? e.name : typeof e}${isTransportFailure(e) ? ', no answer' : ''}) - session ${state?.uploadId ?? '(none)'} kept for the next attempt`
      );
    throw e;
  }
}

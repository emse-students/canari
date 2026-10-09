/**
 * Pure helpers of the resumable upload SESSION (docs/wiki/services/media-streaming-upload.md): the
 * geometry of a blob cut into parts, and the keyless structural check of the `segmented-v1` header a
 * session declares at init. Nothing here touches the disk or the store.
 */
import { BadRequestException } from '@nestjs/common';

/**
 * THE HARD INVARIANT: no request body over 8 MiB, enforced here and not only by the client. The
 * school host's WAF drops bodies over 10 MiB; 8 MiB leaves room for the framing a proxy adds.
 */
export const PART_MAX_BYTES = 8 * 1024 * 1024;
/** A part below this is a client bug or an attempt to inflate the part count. */
export const PART_MIN_BYTES = 1024;
/** Bounds the sidecar and the per-session bookkeeping whatever `partBytes` is declared. */
export const MAX_PARTS = 4096;

/** The public, keyless prefix of a `segmented-v1` blob (frontend `mediaSegmented.ts`). */
export const SEGMENTED_HEADER_BYTES = 20;
const SEGMENTED_MAGIC = Buffer.from('CANARIM', 'ascii');
const SEGMENTED_VERSION = 1;
const SEGMENT_TAG_BYTES = 16;
/** A segment size no writer produces; refusing the absurd keeps `segmentCount` arithmetic honest. */
const SEGMENT_PLAINTEXT_MAX = 64 * 1024 * 1024;

/** What a session needs from the declared header: the size the blob must have. */
export interface DeclaredHeader {
  segmentPlaintextBytes: number;
  plaintextLength: number;
  /** The stored length implied by the header: header + plaintext + one tag per segment. */
  ciphertextLength: number;
}

/**
 * Parses the 20 header bytes (40 hex digits) a client declares at init. Keyless: it checks the shape
 * and derives the length, so a session cannot be opened for a blob the readers would refuse.
 */
export function parseDeclaredHeader(headerHex: unknown): { raw: Buffer; header: DeclaredHeader } {
  if (typeof headerHex !== 'string' || !/^[0-9a-f]{40}$/i.test(headerHex)) {
    throw new BadRequestException('header must be the 20 public header bytes as 40 hex digits');
  }
  const raw = Buffer.from(headerHex, 'hex');
  if (!raw.subarray(0, 7).equals(SEGMENTED_MAGIC)) {
    throw new BadRequestException('header: not a segmented-v1 blob (magic)');
  }
  if (raw[7] !== SEGMENTED_VERSION) {
    throw new BadRequestException('header: unsupported segmented version');
  }
  const segmentPlaintextBytes = raw.readUInt32BE(8);
  if (segmentPlaintextBytes < 1 || segmentPlaintextBytes > SEGMENT_PLAINTEXT_MAX) {
    throw new BadRequestException('header: implausible segment size');
  }
  const plaintextBig = raw.readBigUInt64BE(12);
  if (plaintextBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadRequestException('header: implausible plaintext length');
  }
  const plaintextLength = Number(plaintextBig);
  const segmentCount = Math.max(1, Math.ceil(plaintextLength / segmentPlaintextBytes));
  return {
    raw,
    header: {
      segmentPlaintextBytes,
      plaintextLength,
      ciphertextLength: SEGMENTED_HEADER_BYTES + plaintextLength + segmentCount * SEGMENT_TAG_BYTES,
    },
  };
}

/** How many parts a blob of `totalBytes` is cut into. */
export function partCount(totalBytes: number, partBytes: number): number {
  return Math.ceil(totalBytes / partBytes);
}

/** The exact body length part `index` must carry: `partBytes`, or the remainder for the last. */
export function expectedPartLength(totalBytes: number, partBytes: number, index: number): number {
  const parts = partCount(totalBytes, partBytes);
  return index === parts - 1 ? totalBytes - (parts - 1) * partBytes : partBytes;
}

/**
 * A mutex per key: a chain of promises. Operations on the same key run one after the other; different
 * keys never wait for each other.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, next);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Readable } from 'stream';

/**
 * What a bounded body is, for its refusals: a segment (the default - its 413 carries no `code`, as
 * it always has) or the live's preview image, whose two refusals are typed (owner, 2026-11-07).
 */
export interface BoundedBodyKind {
  /** Named in the 413's message. */
  what: string;
  /** The 413's `code`, or none. */
  tooLargeCode?: string;
  /** The empty body's 400 `code`. */
  emptyCode: string;
}

const SEGMENT: BoundedBodyKind = { what: 'a segment', emptyCode: 'LIVE_SEGMENT_EMPTY' };

/**
 * Reads a raw request body (`application/octet-stream`, which no body parser of this service
 * touches) into ONE buffer, refusing it the moment it is larger than `maxBytes`.
 *
 * A declared `Content-Length` over the bound is refused before a byte is read; a body that grows
 * past it without one (chunked) is refused as soon as it does. An empty body is a 400: a segment of
 * zero bytes is not a segment, nor a poster of zero bytes a poster.
 */
export async function readBoundedBody(
  req: Readable & { headers?: Record<string, string | string[] | undefined> },
  maxBytes: number,
  kind: BoundedBodyKind = SEGMENT
): Promise<Buffer> {
  const tooLarge = () =>
    kind.tooLargeCode
      ? new PayloadTooLargeException({ code: kind.tooLargeCode, maxBytes })
      : new PayloadTooLargeException(`${kind.what} is at most ${maxBytes} bytes`);
  const declared = req.headers?.['content-length'];
  if (typeof declared === 'string' && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // `destroyOnReturn: false`: leaving the loop early (the 413) must not destroy the request, whose
  // socket is the one the refusal is answered on.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) throw tooLarge();
    chunks.push(buf);
  }
  if (total === 0) throw new BadRequestException({ code: kind.emptyCode });
  return Buffer.concat(chunks, total);
}

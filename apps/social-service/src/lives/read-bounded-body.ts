import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { Readable } from 'stream';

/**
 * Reads a raw request body (`application/octet-stream`, which no body parser of this service
 * touches) into ONE buffer, refusing it the moment it is larger than `maxBytes`.
 *
 * A declared `Content-Length` over the bound is refused before a byte is read; a body that grows
 * past it without one (chunked) is refused as soon as it does. An empty body is a 400: a segment of zero bytes is not a segment.
 */
export async function readBoundedBody(
  req: Readable & { headers?: Record<string, string | string[] | undefined> },
  maxBytes: number
): Promise<Buffer> {
  const declared = req.headers?.['content-length'];
  if (typeof declared === 'string' && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    throw new PayloadTooLargeException(`a segment is at most ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // `destroyOnReturn: false`: leaving the loop early (the 413) must not destroy the request, whose
  // socket is the one the refusal is answered on.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeException(`a segment is at most ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) throw new BadRequestException({ code: 'LIVE_SEGMENT_EMPTY' });
  return Buffer.concat(chunks, total);
}

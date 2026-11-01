/**
 * A FAITHFUL FAKE OF media-service's upload sessions (`upload-session.service.ts`), for the client's
 * resumable upload (reels-in-chat RC-5): positional parts of an exact length, a status that lists
 * only what landed, an idempotent `complete` that checks every part and the header, a memo
 * answering a completed session with its mediaId, 409 on a PUT to a completed session, 404 for an
 * unknown or closed id, 403 for another owner. Faults are injected per request, by DECISION, never
 * by a clock: no test using it waits for anything.
 */
import { expect } from 'vitest';
import { REEL_UPLOAD_PART_BYTES, type ResumableUploadPort } from '$lib/utils/resumableUpload';
import { hexEncode } from '$lib/mediaCrypto';
import {
  UploadAbortedError,
  UploadNetworkError,
  type XhrUploadOptions,
} from '$lib/utils/uploadXhr';
import { TransportFailureError } from '$lib/utils/transportFailure';

export type Fault =
  /** No answer, and the server never saw the request (the link died before it left). */
  | 'drop'
  /** As `drop`, thrown the way the XHR transport throws it (`UploadNetworkError`): counted by the outbox. */
  | 'reset'
  /** The server handled it, and the answer was lost on the way back. */
  | 'lose-answer'
  /** The process was killed with the request in flight, before it reached the server: no answer, ever. */
  | 'hang'
  /** The server handled it, and the process was killed before the answer arrived: no answer, ever. */
  | 'hang-after'
  /** The server answered this status without handling the request. */
  | number
  /** Something IN FRONT of the server (a proxy, the WAF) answered this status with an HTML page. */
  | { edge: number }
  /** The server answered this status with this JSON body, without handling the request. */
  | { status: number; body: unknown };

interface FakeSession {
  owner: string;
  totalBytes: number;
  partBytes: number;
  header: string;
  retentionClass: string;
  data: Uint8Array;
  received: Set<number>;
  completed?: string;
  closed?: boolean;
}

export class FakeSessionServer {
  readonly sessions = new Map<string, FakeSession>();
  /** Every request that REACHED the server, in order. */
  readonly seen: Array<{ method: string; path: string; bytes: number }> = [];
  /** Every request the client SENT, whether or not it arrived. */
  readonly sent: Array<{ method: string; path: string; bytes: number }> = [];
  /** Budget reservations, one per init (the server reserves the chat-reel budget once). */
  reservations = 0;
  stored = new Map<string, Uint8Array>();
  private next = 0;
  /** Decides a fault for the n-th request matching (method, path); undefined = serve it. */
  fault: (method: string, path: string, n: number) => Fault | undefined = () => undefined;

  port(owner = 'alice'): ResumableUploadPort {
    return {
      request: async (method, path, body, transport) => {
        const bytes = body instanceof Blob ? body.size : typeof body === 'string' ? body.length : 0;
        if (body instanceof Blob) {
          // Every request body stays under the budget the WAF imposes.
          expect(body.size).toBeLessThanOrEqual(REEL_UPLOAD_PART_BYTES);
        }
        if (transport?.signal?.aborted) throw new UploadAbortedError(transport.signal.reason);
        this.sent.push({ method, path, bytes });
        const n = this.sent.filter((r) => r.method === method && r.path === path).length;
        const fault = this.fault(method, path, n);
        // The shape the app's conformed `fetch` raises for no answer (`conformNativeFetch`): a bare
        // `TypeError` is no longer read as a transport failure.
        if (fault === 'drop') throw new TransportFailureError(new TypeError('Failed to fetch'));
        if (fault === 'reset') throw new UploadNetworkError(path);
        if (fault === 'hang') return this.hung(transport);
        if (typeof fault === 'object' && 'status' in fault)
          return this.json(fault.status, fault.body);
        if (typeof fault === 'object') {
          return new Response('<html><body>Not Found</body></html>', {
            status: fault.edge,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (typeof fault === 'number') {
          return new Response(JSON.stringify({ message: 'injected' }), {
            status: fault,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        this.seen.push({ method, path, bytes });
        const res = await this.handle(owner, method, path, body, transport);
        if (fault === 'lose-answer')
          throw new TransportFailureError(new TypeError('Failed to fetch'));
        if (fault === 'hang-after') return this.hung(transport);
        return res;
      },
    };
  }

  /** A request that never gets an answer; only its own cancel ends it, as an XHR abort would. */
  private hung(transport?: XhrUploadOptions): Promise<Response> {
    return new Promise<Response>((_, reject) =>
      transport?.signal?.addEventListener('abort', () =>
        reject(new UploadAbortedError(transport.signal?.reason))
      )
    );
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handle(
    owner: string,
    method: string,
    path: string,
    body: Blob | string | null,
    transport?: XhrUploadOptions
  ): Promise<Response> {
    if (method === 'POST' && path === '') {
      const req = JSON.parse(body as string) as {
        retentionClass: string;
        totalBytes: number;
        partBytes: number;
        header: string;
      };
      const id = `s${++this.next}`;
      this.reservations++;
      this.sessions.set(id, {
        owner,
        totalBytes: req.totalBytes,
        partBytes: req.partBytes,
        header: req.header,
        retentionClass: req.retentionClass,
        data: new Uint8Array(req.totalBytes),
        received: new Set(),
      });
      return this.json(201, {
        uploadId: id,
        partBytes: req.partBytes,
        totalParts: Math.ceil(req.totalBytes / req.partBytes),
        expiresAt: 0,
      });
    }
    const [, id, verb, index] = path.split('/');
    const s = this.sessions.get(id);
    if (!s || s.closed) return this.json(404, { message: 'Upload session not found or expired' });
    if (s.owner !== owner) return this.json(403, { message: 'Not your upload session' });
    const parts = Math.ceil(s.totalBytes / s.partBytes);
    if (method === 'GET') {
      return this.json(200, {
        totalBytes: s.totalBytes,
        partBytes: s.partBytes,
        totalParts: parts,
        received: [...s.received].sort((a, b) => a - b),
        ...(s.completed ? { mediaId: s.completed } : {}),
      });
    }
    if (method === 'DELETE') {
      if (s.completed) return this.json(409, { message: 'Upload already completed' });
      s.closed = true;
      return this.json(200, { ok: true });
    }
    if (method === 'PUT' && verb === 'parts') {
      if (s.completed) return this.json(409, { message: 'Upload already completed' });
      const i = Number(index);
      const expected = Math.min(s.partBytes, s.totalBytes - i * s.partBytes);
      const bytes = new Uint8Array(await (body as Blob).arrayBuffer());
      if (bytes.length !== expected) return this.json(400, { message: 'wrong part length' });
      s.received.delete(i);
      s.data.set(bytes, i * s.partBytes);
      s.received.add(i);
      transport?.onProgress?.({ loaded: bytes.length, total: bytes.length });
      return this.json(200, { index: i, receivedCount: s.received.size });
    }
    if (method === 'POST' && verb === 'complete') {
      if (s.completed) return this.json(200, { mediaId: s.completed });
      if (s.received.size !== parts) return this.json(409, { message: 'parts are missing' });
      if (hexEncode(s.data.subarray(0, 20)) !== s.header) {
        return this.json(422, { message: 'Staged header differs from the declared header' });
      }
      const mediaId = `media-${id}`;
      s.completed = mediaId;
      this.stored.set(mediaId, s.data.slice());
      return this.json(200, { mediaId });
    }
    return this.json(400, { message: `unrouted ${method} ${path}` });
  }

  /** PUT requests the server received for session `id`. */
  partsReceived(id?: string): number {
    return this.seen.filter((r) => r.method === 'PUT' && (!id || r.path.startsWith(`/${id}/`)))
      .length;
  }
}

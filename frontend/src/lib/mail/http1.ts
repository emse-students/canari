import { Log } from '$lib/utils/Log';
import type { PlaintextStream } from './tlsConnection';

/**
 * HTTP/1.1 OVER ONE PERSISTENT TLS CONNECTION, ON BYTES (docs/wiki/mail-client-transport.md).
 *
 * The mailbox answers Zimbra JSON SOAP at `POST /service/soap`; the browser's `fetch` cannot reach
 * it (no CORS, and the TLS is ours), so this is the HTTP the client speaks inside its tunnel. It is
 * deliberately small: requests one at a time on a keep-alive connection, responses framed by
 * `Content-Length`, by `Transfer-Encoding: chunked`, or by the end of the connection. Every length
 * counts BYTES - a body is never decoded before it is whole, since a multi-byte character can
 * straddle any chunk the network hands over.
 */

/** A request: the client adds `Host` and `Content-Length`. */
export interface HttpRequest {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/** A whole response. Header names are lowercase; repeated headers are joined with `, `. */
export interface HttpResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

/** Why a response could not be read - typed at the throw. */
export type HttpErrorKind =
  /** The bytes are not an HTTP/1.1 response this client can frame. */
  | 'malformed'
  /** The connection ended before the response was whole. */
  | 'ended';

export class HttpProtocolError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    detail: string
  ) {
    super(`HTTP ${kind}: ${detail}`);
    this.name = 'HttpProtocolError';
  }
}

/** The longest status line, header line or chunk-size line accepted. */
const MAX_LINE_BYTES = 16 * 1024;
/** The most header bytes one response may carry. */
const MAX_HEADER_BYTES = 64 * 1024;

const CR = 13;
const LF = 10;
const encoder = new TextEncoder();
/** Header lines are ASCII by the standard; latin1 keeps any stray byte one character. */
const headerDecoder = new TextDecoder('latin1');

/** Serialises `request` for `host`, `Content-Length` included whenever a body is sent. */
export function serializeRequest(host: string, request: HttpRequest): Uint8Array {
  const body = request.body ?? new Uint8Array(0);
  const lines = [`${request.method} ${request.path} HTTP/1.1`, `Host: ${host}`];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new HttpProtocolError('malformed', `a header carries a line break: ${name}`);
    }
    lines.push(`${name}: ${value}`);
  }
  if (request.method === 'POST' || body.length > 0) lines.push(`Content-Length: ${body.length}`);
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** The bytes received and not yet consumed, kept as the chunks they arrived in. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  size = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  /** The first `n` bytes (at most `size`), without consuming them. */
  peek(n: number): Uint8Array {
    return this.copy(Math.min(n, this.size), false);
  }

  /** Consumes and returns the first `n` bytes; `n` must be at most `size`. */
  take(n: number): Uint8Array {
    return this.copy(n, true);
  }

  private copy(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    let i = 0;
    while (filled < n) {
      const chunk = this.chunks[i];
      const part = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, part), filled);
      filled += part;
      if (consume && part < chunk.length) this.chunks[i] = chunk.subarray(part);
      else i++;
    }
    if (consume) {
      this.chunks.splice(0, i);
      this.size -= n;
    }
    return out;
  }
}

/** Index of CRLF in `bytes`, -1 when absent. */
function crlfAt(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === CR && bytes[i + 1] === LF) return i;
  }
  return -1;
}

/** Reads framed responses from a plaintext stream. */
class ResponseReader {
  private readonly queue = new ByteQueue();
  private streamEnded = false;

  constructor(private readonly stream: PlaintextStream) {}

  /** Waits for more bytes; false when the stream ended. */
  private async more(): Promise<boolean> {
    if (this.streamEnded) return false;
    const chunk = await this.stream.read();
    if (chunk === null) {
      this.streamEnded = true;
      return false;
    }
    this.queue.push(chunk);
    return true;
  }

  /** One CRLF-terminated line, without its CRLF. */
  private async line(): Promise<string> {
    for (;;) {
      const at = crlfAt(this.queue.peek(MAX_LINE_BYTES + 2));
      if (at >= 0) {
        const line = this.queue.take(at);
        this.queue.take(2);
        return headerDecoder.decode(line);
      }
      if (this.queue.size > MAX_LINE_BYTES) {
        throw new HttpProtocolError('malformed', `a line longer than ${MAX_LINE_BYTES} bytes`);
      }
      if (!(await this.more())) throw new HttpProtocolError('ended', 'inside a line');
    }
  }

  private async exactly(n: number): Promise<Uint8Array> {
    while (this.queue.size < n) {
      if (!(await this.more())) throw new HttpProtocolError('ended', `inside a ${n}-byte body`);
    }
    return this.queue.take(n);
  }

  private async untilEnd(): Promise<Uint8Array> {
    while (await this.more()) {
      // Everything is kept until the stream ends.
    }
    return this.queue.take(this.queue.size);
  }

  /** Reads header lines up to the empty one. */
  private async headers(): Promise<Map<string, string>> {
    const headers = new Map<string, string>();
    let total = 0;
    for (;;) {
      const line = await this.line();
      if (line === '') return headers;
      total += line.length + 2;
      if (total > MAX_HEADER_BYTES) {
        throw new HttpProtocolError('malformed', `headers over ${MAX_HEADER_BYTES} bytes`);
      }
      const colon = line.indexOf(':');
      if (colon <= 0) throw new HttpProtocolError('malformed', 'a header line without a name');
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const prior = headers.get(name);
      headers.set(name, prior === undefined ? value : `${prior}, ${value}`);
    }
  }

  private async chunked(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const sizeLine = (await this.line()).split(';')[0].trim();
      if (!/^[0-9a-fA-F]+$/.test(sizeLine)) {
        throw new HttpProtocolError('malformed', `a chunk size that is not hexadecimal`);
      }
      const size = parseInt(sizeLine, 16);
      if (size === 0) {
        // Trailers, up to the empty line, are read and dropped.
        while ((await this.line()) !== '') {
          // A trailer this client does not use.
        }
        break;
      }
      parts.push(await this.exactly(size));
      total += size;
      if ((await this.line()) !== '') {
        throw new HttpProtocolError('malformed', 'a chunk not followed by CRLF');
      }
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      body.set(part, at);
      at += part.length;
    }
    return body;
  }

  /** One whole response to a `method` request, and whether the connection stays open after it. */
  async response(method: string): Promise<{ response: HttpResponse; keepAlive: boolean }> {
    for (;;) {
      const statusLine = await this.line();
      const match = /^HTTP\/1\.([01]) (\d{3})(?: .*)?$/.exec(statusLine);
      if (!match) throw new HttpProtocolError('malformed', 'not an HTTP/1.x status line');
      const minor = match[1];
      const status = Number(match[2]);
      const headers = await this.headers();
      // An interim answer (100 Continue) is followed by the real one.
      if (status >= 100 && status < 200) continue;
      const connection = (headers.get('connection') ?? '').toLowerCase();
      let keepAlive =
        minor === '1' ? !connection.includes('close') : connection.includes('keep-alive');
      let body: Uint8Array;
      const encoding = (headers.get('transfer-encoding') ?? '').toLowerCase();
      const length = headers.get('content-length');
      if (method === 'HEAD' || status === 204 || status === 304) {
        body = new Uint8Array(0);
      } else if (encoding.includes('chunked')) {
        body = await this.chunked();
      } else if (length !== undefined) {
        if (!/^\d+$/.test(length)) {
          throw new HttpProtocolError('malformed', 'a Content-Length that is not a number');
        }
        body = await this.exactly(Number(length));
      } else {
        body = await this.untilEnd();
        keepAlive = false;
      }
      return { response: { status, headers, body }, keepAlive };
    }
  }
}

/**
 * HTTP/1.1 requests on one persistent stream, ONE AT A TIME: a request waits for the previous
 * response, so responses can never be paired with the wrong request. When the server says it
 * closes (or a response is framed by the end of the stream), the connection is spent and
 * {@link Http1Connection.usable} turns false; the caller opens a new one.
 */
export class Http1Connection {
  private readonly reader: ResponseReader;
  private queue: Promise<unknown> = Promise.resolve();
  private spent = false;

  constructor(
    private readonly stream: PlaintextStream,
    private readonly host: string
  ) {
    this.reader = new ResponseReader(stream);
  }

  /** Whether another request may be sent on this connection. */
  get usable(): boolean {
    return !this.spent && !this.stream.ended;
  }

  /** Sends `request` once its turn comes and resolves with the whole response. */
  request(request: HttpRequest): Promise<HttpResponse> {
    const run = this.queue.then(() => this.exchange(request));
    // The next request waits for this one to settle, whatever its outcome.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange(request: HttpRequest): Promise<HttpResponse> {
    if (!this.usable) {
      throw new HttpProtocolError('ended', 'the connection is spent');
    }
    Log.d('MAIL-HTTP', `${request.method} ${request.path} (${request.body?.length ?? 0} bytes)`);
    try {
      await this.stream.write(serializeRequest(this.host, request));
      const { response, keepAlive } = await this.reader.response(request.method);
      if (!keepAlive) {
        this.spent = true;
        Log.d('MAIL-HTTP', 'the server closes this connection after the response');
      }
      Log.d('MAIL-HTTP', `answered ${response.status} (${response.body.length} bytes)`);
      return response;
    } catch (err) {
      // A connection that failed mid-exchange cannot be trusted to frame the next response.
      this.spent = true;
      Log.w('MAIL-HTTP', `${request.method} ${request.path} failed`, err);
      throw err;
    }
  }
}

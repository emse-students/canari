import type {
  ByteTransport,
  ByteTransportHandlers,
  TransportEnd,
  TransportOpener,
} from '$lib/mail/transport';
import type { PlaintextStream, TlsEngine } from '$lib/mail/tlsConnection';

/**
 * Test doubles for the mail transport's tests (no production code imports this file).
 *
 * {@link FakeTransport} is the far side of a pipe the test drives by hand; {@link FakeEngine} is a
 * TLS session whose "encryption" is the identity, so a test reads what crossed in clear: the
 * handshake is the client sending `HELLO` and the server answering `SERVER-HELLO`.
 */

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (s: string) => new TextEncoder().encode(s);

export class FakeTransport {
  sent: string[] = [];
  closed = false;
  opens = 0;
  private handlers: ByteTransportHandlers | null = null;
  /** When set, `open` rejects with it. */
  refuseWith: Error | null = null;

  readonly open: TransportOpener = (handlers) => {
    this.opens++;
    if (this.refuseWith) return Promise.reject(this.refuseWith);
    this.handlers = handlers;
    this.closed = false;
    const transport: ByteTransport = {
      send: async (b) => {
        this.sent.push(text(b));
      },
      close: () => {
        if (this.closed) return;
        this.closed = true;
        this.handlers?.onEnd({ kind: 'closed_by_us' });
      },
    };
    return Promise.resolve(transport);
  };

  /** The server sends `s`. */
  deliver(s: string): void {
    this.handlers?.onBytes(bytes(s));
  }

  /** The far side ends the transport. */
  end(end: TransportEnd): void {
    this.handlers?.onEnd(end);
  }
}

export class FakeEngine implements TlsEngine {
  private handshaking = true;
  private outbound: string[] = ['HELLO'];
  private inbound: string[] = [];
  private closedByPeer = false;
  freed = 0;
  /** When the server sends this, the engine throws an error of this `kind`. */
  static readonly POISON = 'POISON';
  poisonKind: unknown = 'certificate';

  feedCiphertext(b: Uint8Array): void {
    const s = text(b);
    if (s === FakeEngine.POISON) {
      this.outbound.push('ALERT');
      throw Object.assign(new Error('bad certificate'), { kind: this.poisonKind });
    }
    if (this.handshaking) {
      if (s === 'SERVER-HELLO') {
        this.handshaking = false;
        this.outbound.push('FINISHED');
      }
      return;
    }
    if (s === 'CLOSE-NOTIFY') {
      this.closedByPeer = true;
      return;
    }
    this.inbound.push(s);
  }
  takeCiphertext(): Uint8Array {
    if (this.handshaking && this.outbound.length === 0) return new Uint8Array(0);
    const out = this.outbound.join('');
    this.outbound = [];
    return bytes(out);
  }
  writePlaintext(data: Uint8Array): void {
    this.outbound.push(text(data));
  }
  readPlaintext(): Uint8Array {
    const out = this.inbound.join('');
    this.inbound = [];
    return bytes(out);
  }
  isHandshaking(): boolean {
    return this.handshaking;
  }
  peerClosed(): boolean {
    return this.closedByPeer;
  }
  close(): void {
    this.outbound.push('MY-CLOSE-NOTIFY');
  }
  free(): void {
    this.freed++;
  }
}

/** A plaintext stream the test writes the server's answers into. */
export class FakeStream implements PlaintextStream {
  written: string[] = [];
  ended = false;
  private pending: Uint8Array[] = [];
  private waiting: ((v: Uint8Array | null) => void) | null = null;
  /** Called on each write, so a test can answer a request as it is sent. */
  onWrite: ((request: string) => void) | null = null;

  async write(data: Uint8Array): Promise<void> {
    const s = text(data);
    this.written.push(s);
    this.onWrite?.(s);
  }
  read(): Promise<Uint8Array | null> {
    const next = this.pending.shift();
    if (next) return Promise.resolve(next);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiting = resolve));
  }
  close(): void {
    this.finish();
  }
  /** The server sends `b`. */
  push(b: Uint8Array | string): void {
    const chunk = typeof b === 'string' ? bytes(b) : b;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(chunk);
    } else this.pending.push(chunk);
  }
  /** The stream ends. */
  finish(): void {
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(null);
    }
  }
}

/** One request the {@link FakeZimbra} received. */
export interface FakeZimbraRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The body as text (a SOAP envelope, an upload's bytes decoded). */
  body: string;
  /** For a SOAP call: the request's name (`SearchRequest`), its element, and the session token. */
  soap: { name: string; element: Record<string, unknown>; token: string | null } | null;
}

/** What the fake answers: a status and a body (JSON is stringified). */
export interface FakeZimbraAnswer {
  status?: number;
  body: unknown;
}

/** A SOAP fault envelope with `code`, as Zimbra answers it (HTTP 500). */
export function zimbraFault(code: string): FakeZimbraAnswer {
  return {
    status: 500,
    body: {
      Body: {
        Fault: {
          Code: { Value: 'soap:Sender' },
          Reason: { Text: `fault ${code}` },
          Detail: { Error: { Code: code, _jsns: 'urn:zimbra' } },
        },
      },
    },
  };
}

/** A SOAP success envelope around `body`. */
export function zimbraBody(body: Record<string, unknown>): FakeZimbraAnswer {
  return { status: 200, body: { Body: body } };
}

/**
 * A fake partage.emse.fr at the HTTP level: it reads each request the client writes on a
 * {@link FakeStream}, records it, and answers with what `answer` returns. Its `openStream` is the
 * `StreamOpener` a `ZimbraSoapClient` is built with.
 */
export class FakeZimbra {
  requests: FakeZimbraRequest[] = [];
  streams: FakeStream[] = [];

  constructor(public answer: (request: FakeZimbraRequest) => FakeZimbraAnswer) {}

  /** The SOAP requests received, by name, in order. */
  get soapNames(): string[] {
    return this.requests.flatMap((r) => (r.soap ? [r.soap.name] : []));
  }

  readonly openStream = async (): Promise<PlaintextStream> => {
    const stream = new FakeStream();
    stream.onWrite = (raw) => {
      const request = FakeZimbra.parse(raw);
      this.requests.push(request);
      const answer = this.answer(request);
      const payload =
        answer.body instanceof Uint8Array
          ? answer.body
          : bytes(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      const head = bytes(
        `HTTP/1.1 ${answer.status ?? 200} X\r\nContent-Length: ${payload.length}\r\n\r\n`
      );
      const out = new Uint8Array(head.length + payload.length);
      out.set(head, 0);
      out.set(payload, head.length);
      stream.push(out);
    };
    this.streams.push(stream);
    return stream;
  };

  private static parse(raw: string): FakeZimbraRequest {
    const split = raw.indexOf('\r\n\r\n');
    const [requestLine, ...headerLines] = raw.slice(0, split).split('\r\n');
    const [method, path] = requestLine.split(' ');
    const headers: Record<string, string> = {};
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const body = raw.slice(split + 4);
    let soap: FakeZimbraRequest['soap'] = null;
    if (path === '/service/soap') {
      const envelope = JSON.parse(body) as {
        Header?: { context?: { authToken?: { _content?: string } } };
        Body: Record<string, Record<string, unknown>>;
      };
      const name = Object.keys(envelope.Body)[0];
      soap = {
        name,
        element: envelope.Body[name],
        token: envelope.Header?.context?.authToken?._content ?? null,
      };
    }
    return { method, path, headers, body, soap };
  }
}

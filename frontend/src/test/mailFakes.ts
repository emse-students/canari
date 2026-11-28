import type {
  ByteTransport,
  ByteTransportHandlers,
  TransportEnd,
  TransportOpener,
} from '$lib/mail/transport';
import type { PlaintextStream, StreamEnd, TlsEngine } from '$lib/mail/tlsConnection';

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
  end: StreamEnd | null = null;
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
    this.finish({ kind: 'closed_by_us' });
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
  /** The stream ends: by default with the server's close_notify, the end that proves a body whole. */
  finish(end: StreamEnd = { kind: 'tls_closed' }): void {
    if (this.ended) return;
    this.ended = true;
    this.end = end;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(null);
    }
  }
}

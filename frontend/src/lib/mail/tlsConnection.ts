import { Log } from '$lib/utils/Log';
import {
  MailTransportError,
  type ByteTransport,
  type TransportEnd,
  type TransportOpener,
} from './transport';

/**
 * ONE TLS CONNECTION TO THE SCHOOL MAILBOX, over either transport (docs/wiki/mail-client.md D3).
 *
 * The TLS is the `mail-tls` crate (rustls) compiled to WASM: the page encrypts and decrypts, the
 * relay or the native socket carries ciphertext. The WASM is loaded the first time a connection
 * is made - the Mail tab - and never at boot ({@link loadMailTlsEngine}).
 */

/** The `mail-tls` WASM's session, as this file drives it (`MailTlsClient` in mail-tls/src/wasm.rs). */
export interface TlsEngine {
  feedCiphertext(bytes: Uint8Array): void;
  takeCiphertext(): Uint8Array;
  writePlaintext(data: Uint8Array): void;
  readPlaintext(): Uint8Array;
  isHandshaking(): boolean;
  peerClosed(): boolean;
  close(): void;
  free(): void;
}

/** Makes a new session; one per connection. */
export type TlsEngineFactory = () => TlsEngine;

/**
 * The kinds the WASM throws (`MailTlsErrorKind::code`), plus `internal` for anything that is not
 * one of them (a trap in the WASM): said apart, never guessed into a TLS kind.
 */
const MAIL_TLS_ERROR_KINDS = [
  'certificate',
  'peer_alert',
  'protocol',
  'closed',
  'internal',
] as const;
export type MailTlsErrorKind = (typeof MAIL_TLS_ERROR_KINDS)[number];

/** A TLS failure, typed by the `kind` the WASM set on its error. */
export class MailTlsError extends Error {
  constructor(
    readonly kind: MailTlsErrorKind,
    detail: string
  ) {
    super(`mail TLS ${kind}: ${detail}`);
    this.name = 'MailTlsError';
  }
}

/** Reads what the WASM threw as a {@link MailTlsError}, by its `kind` field only. */
export function asMailTlsError(err: unknown): MailTlsError {
  if (err instanceof MailTlsError) return err;
  const kind = (err as { kind?: unknown } | null)?.kind;
  // For the log line only: a page shows the KIND, never this text.
  const detail = String(err);
  if (typeof kind === 'string' && (MAIL_TLS_ERROR_KINDS as readonly string[]).includes(kind)) {
    return new MailTlsError(kind as MailTlsErrorKind, detail);
  }
  return new MailTlsError('internal', detail);
}

/** The deadline of the WASM's download, as every first-party fetch has one. */
const WASM_FETCH_DEADLINE_MS = 15_000;

let enginePromise: Promise<TlsEngineFactory> | null = null;

/**
 * Loads the `mail-tls` WASM once and answers its session factory. A DYNAMIC import, so the module
 * and its binary are their own chunk, fetched when the first mail connection is made.
 */
export function loadMailTlsEngine(): Promise<TlsEngineFactory> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    Log.d('MAIL-TLS', 'loading the mail-tls WASM');
    const [bindings, asset] = await Promise.all([
      import('$lib/wasm/mail-tls/mail_tls.js'),
      import('$lib/wasm/mail-tls/mail_tls_bg.wasm?url'),
    ]);
    const url = (asset as { default: string }).default;
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(WASM_FETCH_DEADLINE_MS),
    });
    if (!response.ok) {
      throw new Error(`mail-tls WASM answered ${response.status} at ${url}`);
    }
    await bindings.default({ module_or_path: response });
    Log.d('MAIL-TLS', 'mail-tls WASM ready');
    return () => new bindings.MailTlsClient();
  })().catch((err: unknown) => {
    // Not remembered: the next connection asks again rather than inheriting this failure.
    enginePromise = null;
    Log.w('MAIL-TLS', 'the mail-tls WASM could not be loaded', err);
    throw err;
  });
  return enginePromise;
}

/** A plaintext stream to the mailbox: what the HTTP client reads and writes. */
export interface PlaintextStream {
  /** Sends `data` under TLS. */
  write(data: Uint8Array): Promise<void>;
  /** The next plaintext received, or `null` once the stream ended and everything was read. */
  read(): Promise<Uint8Array | null>;
  /** Whether the stream ended (the far side closed, a failure, or {@link close}). */
  readonly ended: boolean;
  /** Ends the stream: a close_notify, then the transport. */
  close(): void;
}

/** Why a plaintext stream ended: the transport's end, or the TLS failure that ended it. */
export type StreamEnd = TransportEnd | { kind: 'tls'; error: MailTlsError };

/**
 * Opens a TLS connection over a transport from `open`, with a session from `newEngine`, and
 * resolves once the handshake is complete. Rejects with a {@link MailTransportError} (could not
 * open) or a {@link MailTlsError} (the handshake failed - a `certificate` kind is never retried).
 */
export async function connectTls(
  open: TransportOpener,
  newEngine: TlsEngineFactory
): Promise<TlsConnection> {
  const connection = new TlsConnection(newEngine());
  await connection.start(open);
  return connection;
}

/** One TLS session over one transport; see {@link connectTls}. */
export class TlsConnection implements PlaintextStream {
  private transport: ByteTransport | null = null;
  private readonly received: Uint8Array[] = [];
  private readers: (() => void)[] = [];
  private endedWith: StreamEnd | null = null;
  private handshake: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  private abandoned = false;

  constructor(private readonly engine: TlsEngine) {}

  get ended(): boolean {
    return this.endedWith !== null;
  }

  /** How the stream ended, `null` while it runs. */
  get end(): StreamEnd | null {
    return this.endedWith;
  }

  /** Opens the transport, sends the ClientHello, and waits for the handshake to complete. */
  async start(open: TransportOpener): Promise<void> {
    const transport = await open({
      onBytes: (bytes) => this.onCiphertext(bytes),
      onEnd: (end) => this.finish(end),
    });
    this.transport = transport;
    if (this.abandoned) {
      // Closed while the open was in flight: a native open cannot be cancelled, so the socket it
      // made is closed now that it exists.
      Log.d('MAIL-TLS', 'connection abandoned during its open - closing the transport');
      transport.close();
      throw new MailTransportError('closed', 'abandoned during its open');
    }
    // The ClientHello is sent below, so nothing of the handshake can arrive before this exists.
    const handshakeDone = new Promise<void>((resolve, reject) => {
      this.handshake = { resolve, reject };
    });
    if (this.endedWith) {
      this.handshake = null;
      throw this.endError();
    }
    Log.d('MAIL-TLS', 'transport open, handshaking');
    await this.flush();
    await handshakeDone;
    Log.d('MAIL-TLS', 'handshake complete');
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.endedWith) throw this.endError();
    try {
      this.engine.writePlaintext(data);
    } catch (err) {
      const tls = asMailTlsError(err);
      this.finish({ kind: 'tls', error: tls });
      throw tls;
    }
    await this.flush();
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const next = this.received.shift();
      if (next) return next;
      if (this.endedWith) return null;
      await new Promise<void>((resolve) => this.readers.push(resolve));
    }
  }

  close(): void {
    if (this.endedWith) return;
    if (!this.transport) {
      this.abandoned = true;
      this.finish({ kind: 'closed_by_us' });
      return;
    }
    Log.d('MAIL-TLS', 'closing');
    this.engine.close();
    const goodbye = this.engine.takeCiphertext();
    const transport = this.transport;
    this.finish({ kind: 'closed_by_us' });
    const send = goodbye.length > 0 ? transport.send(goodbye) : Promise.resolve();
    send
      .catch((err: unknown) => Log.d('MAIL-TLS', 'close_notify not sent', err))
      .finally(() => transport.close());
  }

  /** Feeds what arrived, sends what is owed, and hands any plaintext to the readers. */
  private onCiphertext(bytes: Uint8Array): void {
    if (this.endedWith) return;
    try {
      this.engine.feedCiphertext(bytes);
    } catch (err) {
      const tls = asMailTlsError(err);
      Log.w('MAIL-TLS', `TLS failed: ${tls.kind}`, tls);
      // The alert the session owes is sent before the transport is closed.
      const alert = this.engine.takeCiphertext();
      const transport = this.transport;
      this.finish({ kind: 'tls', error: tls });
      if (transport) {
        const send = alert.length > 0 ? transport.send(alert) : Promise.resolve();
        void send.catch(() => undefined).finally(() => transport.close());
      }
      return;
    }
    if (this.handshake && !this.engine.isHandshaking()) {
      this.handshake.resolve();
      this.handshake = null;
    }
    const plaintext = this.engine.readPlaintext();
    if (plaintext.length > 0) this.received.push(plaintext);
    void this.flush().catch((err: unknown) => Log.d('MAIL-TLS', 'flush after receive failed', err));
    if (this.engine.peerClosed()) {
      Log.d('MAIL-TLS', 'the server sent its close_notify');
      this.finish({ kind: 'peer_closed' });
      this.transport?.close();
    }
    this.wakeReaders();
  }

  /** Sends whatever the session owes the server. */
  private async flush(): Promise<void> {
    const owed = this.engine.takeCiphertext();
    if (owed.length === 0 || !this.transport) return;
    await this.transport.send(owed);
  }

  /** Records the end once, fails a pending handshake, wakes the readers, frees the session. */
  private finish(end: StreamEnd): void {
    if (this.endedWith) return;
    this.endedWith = end;
    if (this.handshake) {
      this.handshake.reject(end.kind === 'tls' ? end.error : this.endError());
      this.handshake = null;
    }
    this.wakeReaders();
    // Nothing uses the session after its end: every caller takes what it owes before finishing.
    try {
      this.engine.free();
    } catch (err) {
      Log.w('MAIL-TLS', 'the TLS session could not be freed', err);
    }
  }

  private wakeReaders(): void {
    const readers = this.readers;
    this.readers = [];
    for (const wake of readers) wake();
  }

  /** The error a use after the end throws: the TLS failure itself, or a transport `closed`. */
  private endError(): Error {
    const end = this.endedWith;
    if (end?.kind === 'tls') return end.error;
    return new MailTransportError('closed', `connection ended (${end?.kind ?? 'unknown'})`);
  }
}

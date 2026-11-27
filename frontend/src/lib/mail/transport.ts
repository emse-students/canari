/**
 * THE MAIL CLIENT'S BYTE TRANSPORT (docs/wiki/mail-client.md D4, docs/wiki/mail-client-transport.md).
 *
 * The client speaks TLS to the school mailbox itself (`tlsConnection.ts`, the `mail-tls` WASM), so
 * what carries it is a plain pipe of ciphertext, and there are two:
 *
 * - on the web, a WebSocket to the blind relay in chat-gateway (`relayTransport.ts`);
 * - in the apps, a native TCP socket opened by Tauri (`tauriSocketTransport.ts`).
 *
 * Both reach ONE destination fixed on their far side, and both carry the same bytes. Everything
 * above this interface is the same code on every platform.
 */

/** How a transport ended - classified where it is known, never re-read from a message. */
export type TransportEnd =
  /** The far side closed: the ordinary end of a keep-alive connection. */
  | { kind: 'peer_closed' }
  /** This side closed it. */
  | { kind: 'closed_by_us' }
  /** The relay ended it at its byte cap; a new connection is the answer. */
  | { kind: 'byte_cap' }
  /** It failed after it opened (a reset, an upstream error, a protocol fault). */
  | { kind: 'failed'; detail: string };

/** What a transport hands up: bytes as they arrive, and its end, once. */
export interface ByteTransportHandlers {
  onBytes(bytes: Uint8Array): void;
  onEnd(end: TransportEnd): void;
}

/** An open pipe of ciphertext to the mailbox. */
export interface ByteTransport {
  /** Sends `bytes`. Rejects with {@link MailTransportError} `closed` once the transport ended. */
  send(bytes: Uint8Array): Promise<void>;
  /** Closes it; `onEnd` follows with `closed_by_us` (once, whatever ended it first). */
  close(): void;
}

/** Opens a transport; rejects with {@link MailTransportError} when it could not open. */
export type TransportOpener = (handlers: ByteTransportHandlers) => Promise<ByteTransport>;

/** Why a transport could not be used. */
export type MailTransportErrorKind =
  /** It could not open: the relay or the network refused, or nothing answered. */
  | 'unreachable'
  /** It was used after it ended. */
  | 'closed';

/** A transport failure, TYPED at the throw: callers read `kind`, never the message. */
export class MailTransportError extends Error {
  constructor(
    readonly kind: MailTransportErrorKind,
    detail: string
  ) {
    super(`mail transport ${kind}: ${detail}`);
    this.name = 'MailTransportError';
  }
}

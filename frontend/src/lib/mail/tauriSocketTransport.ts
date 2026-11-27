import { Channel, invoke } from '@tauri-apps/api/core';
import { Log } from '$lib/utils/Log';
import {
  MailTransportError,
  type ByteTransportHandlers,
  type TransportEnd,
  type TransportOpener,
} from './transport';

/**
 * How the native socket ended (frontend/src-tauri/src/commands/mail_socket.rs, `MailSocketEnd`),
 * a tagged type serialised by Rust.
 */
export type NativeSocketEnd =
  | { reason: 'peer_closed' }
  | { reason: 'closed_by_page' }
  | { reason: 'read_failed'; detail: string }
  | { reason: 'write_failed'; detail: string };

/** A native end as a {@link TransportEnd}. */
export function nativeEnd(end: NativeSocketEnd): TransportEnd {
  switch (end.reason) {
    case 'peer_closed':
      return { kind: 'peer_closed' };
    case 'closed_by_page':
      return { kind: 'closed_by_us' };
    case 'read_failed':
    case 'write_failed':
      return { kind: 'failed', detail: `${end.reason}: ${end.detail}` };
  }
}

/** The calls the transport makes, a seam for its test. */
export interface NativeSocketBridge {
  open(onData: Channel<ArrayBuffer>, onEnd: Channel<NativeSocketEnd>): Promise<number>;
  write(id: number, bytes: Uint8Array): Promise<void>;
  close(id: number): Promise<void>;
  newChannel<T>(): Channel<T>;
}

/** The Tauri commands of `mail_socket.rs`. The write's body is RAW bytes, never a number array. */
const tauriBridge: NativeSocketBridge = {
  open: (onData, onEnd) => invoke<number>('mail_socket_open', { onData, onEnd }),
  write: (id, bytes) =>
    invoke<void>('mail_socket_write', bytes, { headers: { 'x-mail-socket': String(id) } }),
  close: (id) => invoke<void>('mail_socket_close', { id }),
  newChannel: <T>() => new Channel<T>(),
};

/**
 * Opens the apps' transport: a TCP socket to the mailbox, opened natively. The destination is a
 * constant on the Rust side; nothing here names it.
 *
 * A native command cannot be cancelled: a connection abandoned while its open is in flight closes
 * the transport the moment the open answers (`TlsConnection.close`, the chat socket's rule,
 * durable-rules "Mobile and native").
 */
export function tauriSocketTransport(bridge: NativeSocketBridge = tauriBridge): TransportOpener {
  return async (handlers: ByteTransportHandlers) => {
    Log.d('MAIL-SOCKET', 'opening the native socket');
    let ended = false;
    const onData = bridge.newChannel<ArrayBuffer>();
    onData.onmessage = (bytes) => {
      if (!ended) handlers.onBytes(new Uint8Array(bytes));
    };
    const onEnd = bridge.newChannel<NativeSocketEnd>();
    onEnd.onmessage = (end) => {
      if (ended) return;
      ended = true;
      const mapped = nativeEnd(end);
      if (mapped.kind === 'failed') Log.w('MAIL-SOCKET', 'ended', mapped);
      else Log.d('MAIL-SOCKET', 'ended', mapped);
      handlers.onEnd(mapped);
    };
    let id: number;
    try {
      id = await bridge.open(onData, onEnd);
    } catch (err) {
      const kind = (err as { kind?: unknown } | null)?.kind;
      Log.w('MAIL-SOCKET', `could not open (${typeof kind === 'string' ? kind : 'unknown'})`, err);
      throw new MailTransportError('unreachable', `native socket: ${String(kind ?? err)}`);
    }
    Log.d('MAIL-SOCKET', `open id=${id}`);
    return {
      async send(bytes) {
        if (ended) throw new MailTransportError('closed', `native socket ${id} ended`);
        try {
          await bridge.write(id, bytes);
        } catch (err) {
          Log.w('MAIL-SOCKET', `write to ${id} refused`, err);
          throw new MailTransportError('closed', `native socket ${id} refused the write`);
        }
      },
      close() {
        if (ended) return;
        Log.d('MAIL-SOCKET', `closing ${id}`);
        bridge.close(id).catch((err: unknown) => {
          // Already gone on the native side: its end event is on its way or arrived.
          Log.d('MAIL-SOCKET', `close of ${id} answered`, err);
        });
      },
    };
  };
}

import { Log } from '$lib/utils/Log';
import {
  MailTransportError,
  type ByteTransport,
  type ByteTransportHandlers,
  type TransportEnd,
  type TransportOpener,
} from './transport';

/**
 * The relay's close codes (apps/chat-gateway/src/mail_relay.rs, `close_code`): the end is read
 * from the CODE, never from the reason text.
 */
export const RELAY_CLOSE = {
  UPSTREAM_CLOSED: 4000,
  BYTE_CAP: 4001,
  UPSTREAM_ERROR: 4002,
  PROTOCOL: 4003,
  IDLE: 4004,
  NOT_ELIGIBLE: 4005,
  CAP: 4006,
  UNAVAILABLE: 4007,
} as const;

/**
 * The relay's URL for an API base (`https://host` -> `wss://host/api/mail/relay`). `token` rides in
 * the query for a client whose socket cannot carry the `canari_ws_token` cookie, as on `/api/ws`;
 * `redacted` is the only form a log line may hold.
 */
export function mailRelayUrl(apiBase: string, token?: string): { url: string; redacted: string } {
  const base = `${apiBase.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/mail/relay`;
  return {
    url: token ? `${base}?token=${encodeURIComponent(token)}` : base,
    redacted: token ? `${base}?token=***` : base,
  };
}

/** What a close event says, as a {@link TransportEnd}; `ours` when this side asked for it. */
export function relayEnd(code: number, ours: boolean): TransportEnd {
  if (ours) return { kind: 'closed_by_us' };
  switch (code) {
    case RELAY_CLOSE.UPSTREAM_CLOSED:
    // The relay ends a connection nothing crossed for 90 s, before any hop's cut: ordinary.
    case RELAY_CLOSE.IDLE:
      return { kind: 'peer_closed' };
    case RELAY_CLOSE.BYTE_CAP:
      return { kind: 'byte_cap' };
    case RELAY_CLOSE.UPSTREAM_ERROR:
      return { kind: 'failed', detail: 'the relay lost the upstream' };
    case RELAY_CLOSE.PROTOCOL:
      return { kind: 'failed', detail: 'the relay refused a frame' };
    // The relay's refusals: it upgrades, then closes with one of these, because a browser cannot
    // read the status of a refused upgrade (every refusal would read as the same 1006).
    case RELAY_CLOSE.NOT_ELIGIBLE:
      return { kind: 'refused', reason: 'not_eligible' };
    case RELAY_CLOSE.CAP:
      return { kind: 'refused', reason: 'cap' };
    case RELAY_CLOSE.UNAVAILABLE:
      return { kind: 'refused', reason: 'unavailable' };
    default:
      // 1006 (no close frame: a reset, the 120 s idle bound of nginx) and anything unforeseen.
      return { kind: 'failed', detail: `relay socket closed with code ${code}` };
  }
}

/**
 * Opens the web transport: a WebSocket to the relay at `url`. A browser hides why a WebSocket
 * failed to open, so the relay refuses an ACCOUNT after the upgrade, with a close code
 * ({@link relayEnd}: `refused`, typed). What it still refuses before the upgrade - the switch off,
 * a foreign origin, no token, the upstream unreachable - and nginx's rate limit read the same
 * here, so a refused open is `unreachable`, said with the redacted URL.
 */
export function relayTransport(
  url: string,
  redacted: string,
  socketFactory: (url: string) => WebSocket = (u) => new WebSocket(u)
): TransportOpener {
  return (handlers: ByteTransportHandlers) =>
    new Promise<ByteTransport>((resolve, reject) => {
      Log.d('MAIL-RELAY', `opening ${redacted}`);
      const ws = socketFactory(url);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      let closedByUs = false;
      let ended = false;

      ws.onopen = () => {
        opened = true;
        Log.d('MAIL-RELAY', 'open');
        resolve({
          send(bytes) {
            if (ended || ws.readyState !== WebSocket.OPEN) {
              return Promise.reject(new MailTransportError('closed', 'relay socket ended'));
            }
            // Never a SharedArrayBuffer view: the TLS engine's output is copied out of WASM
            // memory into a fresh ArrayBuffer by wasm-bindgen.
            ws.send(bytes as Uint8Array<ArrayBuffer>);
            return Promise.resolve();
          },
          close() {
            if (ended) return;
            closedByUs = true;
            Log.d('MAIL-RELAY', 'closing');
            ws.close(1000);
          },
        });
      };
      ws.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          handlers.onBytes(new Uint8Array(event.data));
          return;
        }
        // The relay sends binary frames only: anything else is a fault, said, and the end.
        Log.w('MAIL-RELAY', 'a non-binary frame from the relay - closing');
        ws.close(1002);
      };
      ws.onclose = (event: CloseEvent) => {
        if (!opened) {
          Log.w('MAIL-RELAY', `could not open ${redacted} (close code ${event.code})`);
          reject(new MailTransportError('unreachable', `relay refused or unreachable`));
          return;
        }
        if (ended) return;
        ended = true;
        const end = relayEnd(event.code, closedByUs);
        if (end.kind === 'failed' || end.kind === 'refused') Log.w('MAIL-RELAY', 'ended', end);
        else Log.d('MAIL-RELAY', 'ended', end);
        handlers.onEnd(end);
      };
    });
}

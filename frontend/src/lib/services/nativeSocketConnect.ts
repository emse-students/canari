/**
 * The deadline on the native chat socket's connect, and what happens to a socket that completes
 * after it.
 *
 * WHY (CALL-WS-V6, 2026-10-20, docs/wiki/frontend/mobile.md#the-native-socket-races-ipv6-and-ipv4):
 * the plugin's `connect` command cannot be cancelled. A connect abandoned by the deadline still
 * completes natively, and the plugin then holds an OPEN, AUTHENTICATED socket whose frames reach a
 * listener set nobody will ever add to. The gateway counts every socket of a device as a session,
 * so each one kept the device "online" while the frames it received went nowhere. A late socket is
 * therefore closed the moment it appears, and said so at WARN - a late completion means the connect
 * was slower than the deadline, which is the defect, not the close.
 *
 * The close is not harmless: what the gateway sent the socket before it - the connect-time drain of
 * `pending_welcome_notify`, any live frame - is lost to this device (FCM resends a still-pending
 * welcome request). It stops the loss from going on; only a fast connect prevents it.
 */

/** Same deadline as the browser socket in `WebMlsService`. */
export const NATIVE_CONNECT_TIMEOUT_MS = 15_000;

/** The part of the plugin's socket this needs. */
interface ClosableSocket {
  disconnect(): Promise<void>;
}

/**
 * Waits for `pending` (the plugin's `NativeWebSocket.connect`) at most `timeoutMs`. Resolves with
 * the socket, or rejects with a timeout error, after which a late socket is disconnected and a late
 * failure is logged rather than left as an unhandled rejection.
 */
export function connectNativeSocket<S extends ClosableSocket>(
  pending: Promise<S>,
  timeoutMs: number
): Promise<S> {
  const startedAt = Date.now();
  return new Promise<S>((resolve, reject) => {
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      // The rejection is the report: the caller logs it with its reconnect decision.
      reject(new Error(`WebSocket connection timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pending.then(
      (socket) => {
        if (!abandoned) {
          clearTimeout(timer);
          resolve(socket);
          return;
        }
        console.warn(
          `[WS] native socket completed ${Date.now() - startedAt} ms after its connect started, ` +
            `past the ${timeoutMs} ms deadline - closing it`
        );
        socket.disconnect().catch((e: unknown) => {
          console.warn('[WS] closing the late native socket failed:', e);
        });
      },
      (e: unknown) => {
        if (!abandoned) {
          clearTimeout(timer);
          reject(e);
          return;
        }
        console.warn('[WS] abandoned native connect failed afterwards:', e);
      }
    );
  });
}

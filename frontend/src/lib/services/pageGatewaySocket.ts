import { invoke } from '@tauri-apps/api/core';

/** The Rust command recording the statement (`page_ring::set_page_gateway_socket`). */
export const SET_PAGE_GATEWAY_SOCKET_COMMAND = 'set_page_gateway_socket';

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Tells the native side whether this page holds the gateway socket, and so rings an incoming call
 * itself.
 *
 * WHY THE NATIVE RING NEEDS IT: the page rings from the caller's MLS `call_invite`, a transport frame
 * the server delivers only over an open gateway socket. An app in front at the PIN gate holds none -
 * so nothing rang at all while the native ring stood back for "the app is in front" (Mi 9T,
 * 1.5.2-alpha.3, 2026-10-31). Native rings unless the app is in front AND this says `true`
 * (`docs/wiki/frontend/modules/calls.md`, "An open app at the PIN gate rang nothing").
 *
 * Called by the socket's setter in `TauriMlsService` on every change, never by a call site. A failed
 * report is logged and leaves the previous statement in place: no retry, which would reorder it.
 */
export function reportPageGatewaySocket(
  holder: string,
  held: boolean,
  invokeFn: Invoke = invoke
): void {
  console.log(
    held
      ? `[CallRing] ${holder} holds the gateway socket - an incoming call rings in the page`
      : `[CallRing] ${holder} holds no gateway socket - an incoming call rings natively unless another holder does`
  );
  // The command is sent synchronously (an async body runs up to its first await), so two
  // statements leave in the order they were made.
  void (async () => {
    try {
      await invokeFn(SET_PAGE_GATEWAY_SOCKET_COMMAND, { holder, held });
    } catch (e) {
      console.warn(
        `[CallRing] the native side was not told (${holder} held=${held}): ${String(e)} - its ring keeps the previous statement`
      );
    }
  })();
}

/** The last holder id handed out in this document; the native set is cleared per document. */
let lastHolder = 0;

/**
 * A holder id for one socket owner (one `TauriMlsService` instance): two instances that overlap
 * (an account switch) state their sockets apart, so one letting go never erases the other's.
 */
export function nextGatewaySocketHolder(): string {
  lastHolder += 1;
  return `mls-service-${lastHolder}`;
}

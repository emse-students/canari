import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/** The Rust command answering the current document's generation (`page_ring::page_ring_document`). */
export const PAGE_RING_DOCUMENT_COMMAND = 'page_ring_document';
/** The Rust command recording a socket statement (`page_ring::set_page_gateway_socket`). */
export const SET_PAGE_GATEWAY_SOCKET_COMMAND = 'set_page_gateway_socket';
/** The Rust command recording a ringing statement (`page_ring::set_page_ringing_call`). */
export const SET_PAGE_RINGING_CALL_COMMAND = 'set_page_ringing_call';

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * This document's generation (`page_ring_document`). Every statement names it, so the native side
 * ignores one still in flight from a previous document across a navigation - it would otherwise
 * leave a holder nobody withdraws, and a page at the PIN gate counted as ringing rings nothing
 * (#2785's defect again).
 *
 * ASKED WHEN THIS MODULE LOADS, in Tauri: the ask must leave while this document is surely the
 * current one. Asked lazily at the first statement, an old page's first ask could cross a reload
 * and learn the NEW document's generation, and its statements would then count in it.
 *
 * A FAILED ASK IS ASKED AGAIN at the next statement (null here): this module dies with its
 * document, so any answer it gets is this document's own - keeping the failure would only silence
 * every statement for the rest of the page.
 */
let documentGeneration: Promise<number> | null = null;

/**
 * Asks the generation and keeps the answer; a failure is said once and cleared for the next ask.
 *
 * NEVER THROWS INTO ITS CALLER. It runs inside the socket's setter (`TauriMlsService.ws`), so an
 * invoke that throws synchronously, or answers something that is not a promise, must become a
 * rejection of the ask - never an exception that aborts the open or close of the gateway socket. A
 * statement to the native ring is a report about the socket, and cannot be allowed to break it.
 */
function askDocumentGeneration(invokeFn: Invoke): Promise<number> {
  const ask = (async () => {
    const document = await invokeFn(PAGE_RING_DOCUMENT_COMMAND);
    if (typeof document !== 'number') {
      throw new Error(`the document generation is not a number: ${String(document)}`);
    }
    return document;
  })();
  documentGeneration = ask;
  ask.catch((e: unknown) => {
    console.warn(
      `[CallRing] the document generation could not be learned: ${String(e)} - asked again at the next statement`
    );
    if (documentGeneration === ask) documentGeneration = null;
  });
  return ask;
}

if (isTauriRuntime()) askDocumentGeneration(invoke);

/**
 * The statements of this document, in the order they were made: each waits for the one before, so
 * the asynchronous ask of the generation never reorders two of them.
 */
let statements: Promise<void> = Promise.resolve();

/**
 * Sends one statement to the native side, after the ones before it, naming this document. A failed
 * statement is logged and leaves the previous one in place: no retry, which would reorder it.
 */
function state(
  command: string,
  args: Record<string, unknown>,
  label: string,
  invokeFn: Invoke
): void {
  const generation = documentGeneration ?? askDocumentGeneration(invokeFn);
  statements = statements.then(async () => {
    try {
      const document = await generation;
      await invokeFn(command, { ...args, document });
    } catch (e) {
      console.warn(
        `[CallRing] the native side was not told (${label}): ${String(e)} - its ring keeps the previous statement`
      );
    }
  });
}

/**
 * Tells the native side whether this page holds the gateway socket, and so will ring an incoming
 * call itself.
 *
 * WHY THE NATIVE RING NEEDS IT: the page rings from the caller's MLS `call_invite`, a transport frame
 * the server delivers only over an open gateway socket. An app in front at the PIN gate holds none -
 * so nothing rang at all while the native ring stood back for "the app is in front" (Mi 9T,
 * 1.5.2-alpha.3, 2026-10-31). Native rings unless the app is in front AND this says `true`
 * (`docs/wiki/frontend/modules/calls.md`, "An open app at the PIN gate rang nothing").
 *
 * Called by the socket's setter in `TauriMlsService` on every change, never by a call site.
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
  state(SET_PAGE_GATEWAY_SOCKET_COMMAND, { holder, held }, `${holder} held=${held}`, invokeFn);
}

/**
 * Tells the native side which call this page is ringing itself (`CallService` `incoming` on it), or
 * `null` for none.
 *
 * WHY "HOLDS A SOCKET" IS NOT ENOUGH: the iPhone's handover ends an UNANSWERED CallKit ring once the
 * app is active only when the page rings that call. A page that holds a socket may still have
 * missed the call's invite - skipped while the page sat at the PIN gate, before the unlock opened
 * the socket - and ending the CallKit ring then ended the call's only ring (review of #2785).
 *
 * Called by `CallService` on every change of the call it rings, never by a call site.
 */
export function reportPageRingingCall(
  holder: string,
  callId: string | null,
  invokeFn: Invoke = invoke
): void {
  console.log(
    callId
      ? `[CallRing] ${holder} rings call=${callId} in the page`
      : `[CallRing] ${holder} rings no call in the page`
  );
  state(SET_PAGE_RINGING_CALL_COMMAND, { holder, callId }, `${holder} call=${callId}`, invokeFn);
}

/** The last holder id handed out in this document; the native facts are cleared per document. */
let lastHolder = 0;

/**
 * A holder id for one owner of a fact (one `TauriMlsService` or `CallService` instance): two
 * instances that overlap (an account switch) state their facts apart, so one letting go never erases
 * the other's.
 */
export function nextPageRingHolder(kind: 'mls-service' | 'call-service'): string {
  lastHolder += 1;
  return `${kind}-${lastHolder}`;
}

/**
 * What a platform open of the gateway socket is handed by `BaseMlsService`, and the one way such an
 * open ends without having failed.
 *
 * Every open of this document's socket goes through one queue on the base class. A pause (the app
 * backgrounded, a sign-out releasing a login) FENCES that queue: it advances a generation, and an
 * open started before it must neither assign a socket nor keep the queue waiting on a deadline.
 */

/** The parameters of ONE platform open. */
export interface GatewaySocketOpen {
  /** The device id this socket carries - recorded by the caller; never re-read the live one. */
  deviceId: string;
  /** The access token, fetched by the caller, so a platform open has no await of its own for it. */
  token: string;
  /**
   * `false` once a pause has fenced this open off. Re-checked after EVERY await of the platform
   * open, before it assigns or keeps a socket: a socket assigned after a pause outlives it.
   */
  isCurrent(): boolean;
  /**
   * Registers what abandoning this open must undo - its deadline, the half-open socket. Run
   * synchronously by the pause, which then settles the open: the queue never waits on a clock.
   */
  onAbandon(cleanup: () => void): void;
}

/**
 * An open the pause abandoned. NOT a transport failure: nothing was refused, the open was simply no
 * longer wanted, so a caller that sees it schedules no reconnect and accuses nothing.
 */
export class GatewayOpenAbandonedError extends Error {
  constructor(readonly reason: string) {
    super(`gateway socket open abandoned (${reason})`);
    this.name = 'GatewayOpenAbandonedError';
  }
}

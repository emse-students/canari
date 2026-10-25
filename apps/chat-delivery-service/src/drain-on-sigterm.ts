import { Logger } from '@nestjs/common';
import type { Server } from 'node:http';

/** The process-level events this module listens on; `process` in production, a stand-in in tests. */
type SignalSource = Pick<NodeJS.EventEmitter, 'once'>;

/**
 * Makes a REPLACED replica leave without dropping a request: on SIGTERM it stops listening, answers
 * every request already in flight, then exits.
 *
 * WHY (2026-10-17, docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to). A release
 * starts this service's new replica beside the old one, waits until it is healthy, then stops the old
 * one with SIGTERM. Two things went wrong without this. The process runs as PID 1, where a signal
 * with no handler is IGNORED - so the old replica went on accepting requests for the whole ten-second
 * stop timeout and was then SIGKILLed with some of them half-answered: a 502 on a POST nginx may not
 * replay. With the listener closed instead, a new connection to the old replica is REFUSED, and a
 * refused connect is the one failure nginx hands to the next address (the new replica) with no byte
 * sent.
 *
 * Only the HTTP listener is closed - not the Nest application. `app.close()` would run the module
 * destroy hooks first and tear down the database and Redis connections that the requests still in
 * flight are using.
 *
 * Every NestJS service carries its own copy of this file: the four are built and shipped as separate
 * images with no shared library between them.
 *
 * @param server the HTTP server the application listens with (`app.getHttpServer()`).
 * @param exit how the process leaves once drained - `process.exit` in production.
 * @param signals where SIGTERM arrives - `process` in production.
 * @param beforeExit work the process still owes after its last request was answered (the join-ask
 *   announcements started AFTER an answer); awaited, then the process exits. A failure is logged and
 *   does not stop the exit.
 */
export function drainOnSigterm(
  server: Pick<Server, 'close'>,
  exit: (code: number) => void = (code) => process.exit(code),
  signals: SignalSource = process,
  beforeExit: () => Promise<void> = () => Promise.resolve()
): void {
  const logger = new Logger('Drain');
  signals.once('SIGTERM', () => {
    logger.log(
      '[DRAIN] SIGTERM - closing the listener; requests in flight are answered, then the process exits'
    );
    server.close((err?: Error) => {
      if (err) {
        // `close` reports an error only when the server was not listening, so there is nothing left
        // to drain - but it means this replica was not the one serving, which is worth seeing.
        logger.error(`[DRAIN] the listener was not open: ${err.message}`);
        exit(1);
        return;
      }
      logger.log(
        '[DRAIN] every request in flight was answered - finishing what it owes, then exiting'
      );
      beforeExit()
        .catch((e: unknown) => logger.error(`[DRAIN] work owed before exit failed: ${String(e)}`))
        .finally(() => exit(0));
    });
  });
}

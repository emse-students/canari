import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { drainOnSigterm } from './drain-on-sigterm';

/** One GET to the server, resolved with its status or rejected with the transport error. */
function get(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
}

/** A promise the test settles by hand, so every wait below is on an event and never on a clock. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The exit stand-in: records every code, and resolves `first` with the first one. */
function exitRecorder() {
  const codes: number[] = [];
  const first = deferred<number>();
  return {
    codes,
    first: first.promise,
    exit: (code: number) => {
      codes.push(code);
      first.resolve(code);
    },
  };
}

/**
 * The replica a release retires must answer what it already accepted and refuse what it has not -
 * a refused connect is what nginx hands to the new replica; a request cut half-way is a 502
 * (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
 *
 * Driven by events, never by a clock: the handler says when a request arrived and answers when the
 * test releases it, and the exit stand-in resolves when the process would leave.
 */
describe('drainOnSigterm', () => {
  it('answers the request in flight, refuses a new connection, and exits only once drained', async () => {
    const arrived = deferred();
    const held = deferred();
    const server = http.createServer((_req, res) => {
      arrived.resolve();
      void held.promise.then(() => res.end('done'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const signals = new EventEmitter();
    const exits = exitRecorder();
    drainOnSigterm(server, exits.exit, signals);

    const inFlight = get(port);
    await arrived.promise;
    signals.emit('SIGTERM');

    await expect(get(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    // The request in flight is still held, so the server cannot have drained.
    expect(exits.codes).toEqual([]);
    held.resolve();
    await expect(inFlight).resolves.toBe(200);
    await expect(exits.first).resolves.toBe(0);
    expect(exits.codes).toEqual([0]);
  });

  it('awaits the work it still owes after the last answer, then exits', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const signals = new EventEmitter();
    const exits = exitRecorder();
    const asked = deferred();
    const owed = deferred();
    drainOnSigterm(server, exits.exit, signals, () => {
      asked.resolve();
      return owed.promise;
    });

    signals.emit('SIGTERM');
    // The listener is closed and nothing is in flight, yet the process stays up for what it owes.
    await asked.promise;
    expect(exits.codes).toEqual([]);
    owed.resolve();
    await expect(exits.first).resolves.toBe(0);
  });

  it('exits even when the owed work fails', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const signals = new EventEmitter();
    const exits = exitRecorder();
    drainOnSigterm(server, exits.exit, signals, () =>
      Promise.reject(new Error('owed work failed'))
    );
    signals.emit('SIGTERM');

    await expect(exits.first).resolves.toBe(0);
    expect(exits.codes).toEqual([0]);
  });

  it('does nothing before SIGTERM', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const exits = exitRecorder();
    drainOnSigterm(server, exits.exit, new EventEmitter());

    await expect(get(port)).resolves.toBe(200);
    expect(exits.codes).toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

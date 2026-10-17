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

/**
 * The replica a release retires must answer what it already accepted and refuse what it has not -
 * a refused connect is what nginx hands to the new replica; a request cut half-way is a 502
 * (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
 */
describe('drainOnSigterm', () => {
  it('answers the request in flight, refuses a new connection, and exits only once drained', async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end('done'), 300);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const signals = new EventEmitter();
    const exits: number[] = [];
    drainOnSigterm(server, (code) => exits.push(code), signals);

    const inFlight = get(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGTERM');

    await expect(get(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(exits).toEqual([]);
    await expect(inFlight).resolves.toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exits).toEqual([0]);
  });

  it('does nothing before SIGTERM', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const exits: number[] = [];
    drainOnSigterm(server, (code) => exits.push(code), new EventEmitter());

    await expect(get(port)).resolves.toBe(200);
    expect(exits).toEqual([]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, FakeTransport } from '../../test/mailFakes';
import {
  MailTlsError,
  MailTlsLoadError,
  TlsConnection,
  asMailTlsError,
  connectTls,
  loadMailTlsEngine,
} from './tlsConnection';
import { MailTransportError } from './transport';

const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Lets pending promise callbacks run until `done()` holds - no clock involved. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await Promise.resolve();
  expect(done()).toBe(true);
}

/** A connection whose handshake the fake server completes as soon as the ClientHello is sent. */
async function connected(): Promise<{
  connection: TlsConnection;
  transport: FakeTransport;
  engine: FakeEngine;
}> {
  const transport = new FakeTransport();
  const engine = new FakeEngine();
  const pending = connectTls(transport.open, () => engine);
  // The ClientHello leaves when the transport opens; the server answers it.
  await until(() => transport.sent.includes('HELLO'));
  transport.deliver('SERVER-HELLO');
  return { connection: await pending, transport, engine };
}

describe('TlsConnection', () => {
  it('sends the ClientHello on open and resolves once the handshake completes', async () => {
    const { transport } = await connected();
    expect(transport.sent[0]).toBe('HELLO');
    // What the session owed after the server's hello left at once.
    expect(transport.sent).toContain('FINISHED');
  });

  it('carries plaintext both ways', async () => {
    const { connection, transport } = await connected();
    await connection.write(utf8('POST /service/soap'));
    expect(transport.sent.at(-1)).toBe('POST /service/soap');
    transport.deliver('HTTP/1.1 200 OK');
    expect(text(await connection.read())).toBe('HTTP/1.1 200 OK');
  });

  it("ends on the server's close_notify as tls_closed: the reader gets what came, then null", async () => {
    const { connection, transport, engine } = await connected();
    transport.deliver('last bytes');
    transport.deliver('CLOSE-NOTIFY');
    expect(text(await connection.read())).toBe('last bytes');
    expect(await connection.read()).toBeNull();
    expect(connection.end).toEqual({ kind: 'tls_closed' });
    expect(transport.closed).toBe(true);
    expect(engine.freed).toBe(1);
  });

  it('a certificate refusal fails the handshake, typed, after the alert is sent', async () => {
    const transport = new FakeTransport();
    const engine = new FakeEngine();
    const pending = connectTls(transport.open, () => engine);
    await until(() => transport.sent.includes('HELLO'));
    transport.deliver(FakeEngine.POISON);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTlsError);
    expect((err as MailTlsError).kind).toBe('certificate');
    await until(() => transport.closed);
    expect(transport.sent).toContain('ALERT');
    expect(engine.freed).toBe(1);
  });

  it('a transport that ends without a close_notify is told apart from one', async () => {
    const { connection, transport } = await connected();
    transport.end({ kind: 'peer_closed' });
    expect(await connection.read()).toBeNull();
    expect(connection.end).toEqual({ kind: 'peer_closed' });
  });

  it('a transport that ends during the handshake fails it as a transport error', async () => {
    const transport = new FakeTransport();
    const pending = connectTls(transport.open, () => new FakeEngine());
    await until(() => transport.sent.includes('HELLO'));
    transport.end({ kind: 'failed', detail: 'reset' });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailTransportError);
    expect((err as MailTransportError).kind).toBe('closed');
  });

  it('a transport that cannot open is unreachable, and nothing is left pending', async () => {
    const transport = new FakeTransport();
    transport.refuseWith = new MailTransportError('unreachable', 'refused');
    await expect(connectTls(transport.open, () => new FakeEngine())).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('close sends the close_notify, then closes the transport; a write after it is refused', async () => {
    const { connection, transport, engine } = await connected();
    connection.close();
    await until(() => transport.closed);
    expect(transport.sent.at(-1)).toBe('MY-CLOSE-NOTIFY');
    expect(connection.end).toEqual({ kind: 'closed_by_us' });
    expect(engine.freed).toBe(1);
    await expect(connection.write(utf8('late'))).rejects.toMatchObject({ kind: 'closed' });
  });

  it('a connection closed while its transport opens closes that transport when it exists', async () => {
    const transport = new FakeTransport();
    const connection = new TlsConnection(new FakeEngine());
    const started = connection.start(transport.open);
    connection.close();
    await expect(started).rejects.toMatchObject({ kind: 'closed' });
    expect(transport.closed).toBe(true);
    expect(transport.sent).toEqual([]);
  });
});

describe('asMailTlsError', () => {
  it("reads the WASM error's kind, and calls anything else internal", () => {
    for (const kind of ['certificate', 'peer_alert', 'protocol', 'closed'] as const) {
      expect(asMailTlsError(Object.assign(new Error('x'), { kind })).kind).toBe(kind);
    }
    expect(asMailTlsError(Object.assign(new Error('x'), { kind: 'incompatible' })).kind).toBe(
      'incompatible'
    );
    expect(asMailTlsError(new WebAssembly.RuntimeError('unreachable')).kind).toBe('internal');
    expect(asMailTlsError(Object.assign(new Error('x'), { kind: 'novel' })).kind).toBe('internal');
  });
});

describe('loadMailTlsEngine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a binary that is not served is a typed load error, not remembered', async () => {
    const fetch = vi.fn(async () => new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(loadMailTlsEngine()).rejects.toMatchObject({
      name: 'MailTlsLoadError',
      kind: 'http_status',
    });
    await expect(loadMailTlsEngine()).rejects.toBeInstanceOf(MailTlsLoadError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a download that fails is a typed load error of kind unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    await expect(loadMailTlsEngine()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

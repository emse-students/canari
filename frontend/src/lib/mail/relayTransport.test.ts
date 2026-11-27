import { describe, expect, it } from 'vitest';
import { RELAY_CLOSE, mailRelayUrl, relayEnd, relayTransport } from './relayTransport';
import type { TransportEnd } from './transport';

/** The part of a WebSocket the relay transport touches, driven by the test. */
class FakeSocket {
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(readonly url: string) {}
  send(b: Uint8Array) {
    this.sent.push(b);
  }
  close(code: number) {
    this.closedWith = code;
  }
  /** The relay accepts the upgrade. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The socket closes with `code`. */
  shut(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function opener() {
  const sockets: FakeSocket[] = [];
  const open = relayTransport('wss://x/api/mail/relay', 'wss://x/api/mail/relay', (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s as unknown as WebSocket;
  });
  const received: string[] = [];
  const ends: TransportEnd[] = [];
  const pending = open({
    onBytes: (b) => received.push(new TextDecoder().decode(b)),
    onEnd: (e) => ends.push(e),
  });
  return { sockets, pending, received, ends };
}

describe('mailRelayUrl', () => {
  it('turns the API base into the relay URL, and never logs the token', () => {
    expect(mailRelayUrl('https://dev.example.test/')).toEqual({
      url: 'wss://dev.example.test/api/mail/relay',
      redacted: 'wss://dev.example.test/api/mail/relay',
    });
    const withToken = mailRelayUrl('http://localhost:3000', 'a b');
    expect(withToken.url).toBe('ws://localhost:3000/api/mail/relay?token=a%20b');
    expect(withToken.redacted).toBe('ws://localhost:3000/api/mail/relay?token=***');
  });
});

describe('relayEnd', () => {
  it("reads the end from the relay's close code", () => {
    expect(relayEnd(RELAY_CLOSE.UPSTREAM_CLOSED, false)).toEqual({ kind: 'peer_closed' });
    expect(relayEnd(RELAY_CLOSE.BYTE_CAP, false)).toEqual({ kind: 'byte_cap' });
    expect(relayEnd(RELAY_CLOSE.UPSTREAM_ERROR, false).kind).toBe('failed');
    expect(relayEnd(RELAY_CLOSE.PROTOCOL, false).kind).toBe('failed');
    expect(relayEnd(1006, false).kind).toBe('failed');
    expect(relayEnd(1006, true)).toEqual({ kind: 'closed_by_us' });
  });
});

describe('relayTransport', () => {
  it('resolves on open, sends binary, and hands received bytes over', async () => {
    const { sockets, pending, received } = opener();
    expect(sockets[0].binaryType).toBe('arraybuffer');
    sockets[0].accept();
    const transport = await pending;
    await transport.send(new Uint8Array([1, 2]));
    expect(sockets[0].sent).toEqual([new Uint8Array([1, 2])]);
    sockets[0].onmessage?.({ data: new TextEncoder().encode('tls').buffer });
    expect(received).toEqual(['tls']);
  });

  it('a socket refused before opening is unreachable', async () => {
    const { sockets, pending } = opener();
    sockets[0].shut(1006);
    await expect(pending).rejects.toMatchObject({
      name: 'MailTransportError',
      kind: 'unreachable',
    });
  });

  it('ends once, typed by the close code, and refuses a send after', async () => {
    const { sockets, pending, ends } = opener();
    sockets[0].accept();
    const transport = await pending;
    sockets[0].shut(RELAY_CLOSE.BYTE_CAP);
    sockets[0].shut(1006);
    expect(ends).toEqual([{ kind: 'byte_cap' }]);
    await expect(transport.send(new Uint8Array([1]))).rejects.toMatchObject({ kind: 'closed' });
  });

  it('our close is closed_by_us; a text frame from the relay closes the socket', async () => {
    const { sockets, pending, ends } = opener();
    sockets[0].accept();
    const transport = await pending;
    sockets[0].onmessage?.({ data: 'text' });
    expect(sockets[0].closedWith).toBe(1002);
    transport.close();
    expect(sockets[0].closedWith).toBe(1000);
    sockets[0].shut(1000);
    expect(ends).toEqual([{ kind: 'closed_by_us' }]);
  });
});

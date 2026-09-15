/**
 * A SOCKET THE BROWSER TORE DOWN BECAUSE THE PAGE IS LEAVING IS NOT A CONNECTION THAT WAS LOST.
 *
 * Both arrive at `onclose` as code 1006 with no reason, so until the flag below existed the handler
 * could not tell them apart and did the same thing for both: warn, and schedule a reconnect. On a
 * reload that reconnect is for a document that no longer exists.
 *
 * It was read on the user's own Firefox export of 2026-09-15, where `[WS] Disconnected. Code: 1006`
 * and `Connection lost. Retrying in 1s...` are the FIRST TWO LINES of the new page's console - and
 * are attributable at all only because the source column names the PREVIOUS page's bundle.
 *
 * The three cases are the three states the page can be in when a close arrives, and the middle one
 * is the reason this is a pair of events rather than one: a bfcache restore brings the same document
 * back with a socket that really is gone, and that reconnect must happen.
 */
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn().mockResolvedValue({ tag: 'wasm-client' }),
}));

import { WebMlsService } from './WebMlsService';

/**
 * The browser socket, replaced by a handle the test can close by hand.
 *
 * Nothing here simulates a network: the only thing under test is which branch `onclose` takes, and
 * that is decided by an event the page dispatches, never by anything the socket does.
 */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {}
}

/** Opens a connected service whose reconnect callback is observable. */
async function connected() {
  const service = new WebMlsService();
  const reconnect = vi.fn();
  service.onDisconnect(reconnect);

  const promise = service.connect('token');
  FakeSocket.last!.onopen!();
  await promise;

  return { service, reconnect, socket: FakeSocket.last! };
}

describe('WebMlsService page lifecycle', () => {
  beforeEach(() => {
    FakeSocket.last = null;
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats a close with the page still there as a lost connection', async () => {
    const { reconnect, socket } = await connected();

    socket.readyState = 3;
    socket.onclose!({ code: 1006, reason: '' });

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[WS] Disconnected'));
  });

  it('says nothing and reconnects nothing for a close that follows pagehide', async () => {
    const { reconnect, socket } = await connected();

    window.dispatchEvent(new Event('pagehide'));
    socket.readyState = 3;
    socket.onclose!({ code: 1006, reason: '' });

    expect(reconnect).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reconnects when the same document comes back from the back/forward cache', async () => {
    const { reconnect, socket } = await connected();

    window.dispatchEvent(new Event('pagehide'));
    socket.readyState = 3;
    socket.onclose!({ code: 1006, reason: '' });
    expect(reconnect).not.toHaveBeenCalled();

    // The document is restored: the socket really is gone now, and nobody else will notice.
    window.dispatchEvent(new Event('pageshow'));

    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});

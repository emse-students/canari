// @vitest-environment happy-dom
/**
 * The browser half of `TauriMlsService.destroyFence.test.ts`: a destroyed client holds no gateway
 * socket, and none lands on it later. Before the fence the web destroy did not close its socket at
 * all - the browser kept answering the gateway's pings for a client nothing held any more.
 */
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));

import { WebMlsService } from './WebMlsService';
import { GatewayOpenAbandonedError } from '$lib/mls-client/gatewaySocketOpen';

/** The browser socket: records what it was sent; opens only when told. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: (() => void) | null = null;
  closed = false;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

function makeService(): WebMlsService {
  const svc = new WebMlsService();
  (svc as unknown as { deviceId: string }).deviceId = 'web-u-dev';
  return svc;
}

describe('WebMlsService - the gateway socket of a destroyed client', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('an open socket is closed with its departure signal at the destroy', async () => {
    const svc = makeService();
    const opened = svc.connect('token', svc.socketFence());
    FakeSocket.all[0].open();
    await opened;

    svc.destroy();
    expect(FakeSocket.all[0].sent).toContain(JSON.stringify({ type: 'disconnect' }));
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(svc.isWsOpen()).toBe(false);
  });

  it('a socket still opening at the destroy is abandoned and closed, never kept', async () => {
    const svc = makeService();
    const opening = svc.connect('token', svc.socketFence());
    expect(FakeSocket.all).toHaveLength(1);

    svc.destroy();
    await expect(opening).rejects.toBeInstanceOf(GatewayOpenAbandonedError);
    // The handshake completing afterwards changes nothing.
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(svc.isWsOpen()).toBe(false);
  });

  it('no connect opens a socket on a destroyed client', async () => {
    const svc = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.destroy();
    await expect(svc.connect('token', svc.socketFence())).rejects.toBeInstanceOf(
      GatewayOpenAbandonedError
    );
    expect(FakeSocket.all).toHaveLength(0);
  });
});

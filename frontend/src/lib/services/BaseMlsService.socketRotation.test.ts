// @vitest-environment happy-dom
/**
 * THE GATEWAY SOCKET FOLLOWS THE DEVICE IDENTITY, AT THE MOMENT THE IDENTITY CHANGES - AND A PAUSE
 * FENCES IT.
 *
 * The login starts its handshake beside the MLS state load (`startGatewayHandshake`), and that load
 * can rotate the device identity (`reenrolLostState`, a credential mismatch); a revoked KeyPackage
 * round rotates it after the connect. The gateway routes by the `device_id` in the socket URL, so a
 * socket opened under the abandoned id received nothing addressed to the new one until its next
 * reconnect - and the retirement of the old id was signalled (`device_revoked`) to that very socket.
 * Reproduced on a web pre-release 2026-10-25.
 *
 * The real `connect`, `pauseSocket`, `rotateDeviceIdentity`, `generateKeyPackage` and socket queue
 * run here on a real `WebMlsService`; only the browser socket, the state load and the network are
 * stubbed. The Tauri half of the fence is in `TauriMlsService.socketRotation.test.ts`.
 */
const getToken = vi.hoisted(() => vi.fn());

vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn().mockResolvedValue({ tag: 'wasm-client' }),
}));
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getToken,
}));

import { WebMlsService } from './WebMlsService';
import { readAbandonedDeviceIds, recordAbandonedDevice } from '$lib/mls-client/abandonedDevices';
import { DeviceRevokedError } from '$lib/mls-client/mlsDeliveryApi';
import { GatewayOpenAbandonedError } from '$lib/mls-client/gatewaySocketOpen';

const USER = 'u';

/** The browser socket: records its URL and what it was sent; opens or fails only when told. */
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
  get deviceId(): string | null {
    return new URL(this.url).searchParams.get('device_id');
  }
}

interface Internals {
  userId: string;
  deviceId: string;
  delivery: { userId: string; deviceId: string };
  rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string>;
  retireAbandonedIds(): void;
  generateKeyPackageImpl(key: string): Promise<unknown>;
}

function makeService() {
  const svc = new WebMlsService();
  const internals = svc as unknown as Internals;
  internals.userId = USER;
  internals.deviceId = 'web-u-old';
  internals.delivery.deviceId = 'web-u-old';
  // Own properties shadow the prototype: the id minted, and a state load and checkpoint that succeed.
  Object.assign(svc, {
    generateDeviceId: vi.fn().mockReturnValue('web-u-new'),
    loadStateWithKey: vi.fn().mockResolvedValue(undefined),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
  });
  const deleteDevice = vi
    .spyOn(svc, 'deleteDevice')
    .mockResolvedValue({ status: 'deleted' } as Awaited<ReturnType<typeof svc.deleteDevice>>);
  const fetchPending = vi.spyOn(svc, 'fetchPendingMessages').mockResolvedValue(undefined);
  const reconnect = vi.fn();
  return { svc, internals, deleteDevice, fetchPending, reconnect };
}

/** Opens the first socket, under the old id. */
async function openUnderOldId(svc: WebMlsService): Promise<FakeSocket> {
  const first = svc.connect('token', svc.socketFence());
  FakeSocket.all[0].open();
  await first;
  return FakeSocket.all[0];
}

/** Lets every queued microtask and resolved promise run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the gateway socket across a device identity rotation', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    localStorage.clear();
    sessionStorage.clear();
    getToken.mockReset().mockResolvedValue('fresh-token');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reopens an open socket under the new id, and retires the old id only after', async () => {
    const { svc, internals, deleteDevice, reconnect } = makeService();
    svc.onDisconnect(reconnect);
    const old = await openUnderOldId(svc);
    expect(old.deviceId).toBe('web-u-old');

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();

    // The reopen is queued: the departure signal on the old socket, then a socket under the NEW id
    // carrying the token the reopen fetched itself.
    expect(old.sent).toContain(JSON.stringify({ type: 'disconnect' }));
    expect(old.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].deviceId).toBe('web-u-new');
    expect(new URL(FakeSocket.all[1].url).searchParams.get('token')).toBe('fresh-token');
    // Not one delete while the only socket of this document could still carry the old id.
    expect(deleteDevice).not.toHaveBeenCalled();

    const settled = svc.gatewaySocketSettled();
    FakeSocket.all[1].open();
    await settled;
    await flush();

    expect(deleteDevice).toHaveBeenCalledTimes(1);
    expect(deleteDevice).toHaveBeenCalledWith(USER, 'web-u-old');
    expect(readAbandonedDeviceIds(USER)).toEqual([]);
    // Replacing the socket is not losing it.
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('replaces a socket that was still OPENING under the old id when the rotation landed', async () => {
    const { svc, internals } = makeService();
    // The login's handshake: started, its URL already built under the old id, not yet open.
    const handshake = svc.connect('token', svc.socketFence());
    expect(FakeSocket.all[0].deviceId).toBe('web-u-old');

    await internals.rotateDeviceIdentity('key', 'credential mismatch');
    await flush();
    // Nothing is torn down under an open in flight: the reopen waits for it.
    expect(FakeSocket.all).toHaveLength(1);

    FakeSocket.all[0].open();
    await handshake;
    await flush();

    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].deviceId).toBe('web-u-new');
    // The post-connect half waits here, so it cannot run on the abandoned socket.
    let settled = false;
    const waiting = svc.gatewaySocketSettled().then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    FakeSocket.all[1].open();
    await waiting;
    expect(svc.isWsOpen()).toBe(true);
  });

  it('opens nothing when no socket is open - the next open reads the new id', async () => {
    const { svc, internals, deleteDevice } = makeService();

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();

    expect(FakeSocket.all).toHaveLength(0);
    expect(deleteDevice).toHaveBeenCalledWith(USER, 'web-u-old');

    const later = svc.connect('token', svc.socketFence());
    FakeSocket.all[0].open();
    await later;
    expect(FakeSocket.all[0].deviceId).toBe('web-u-new');
  });

  it('reports a failed reopen on the disconnect seam and fails the settle with its own error', async () => {
    const { svc, internals, reconnect } = makeService();
    svc.onDisconnect(reconnect);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openUnderOldId(svc);

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();
    const settled = svc.gatewaySocketSettled();
    FakeSocket.all[1].onerror?.(new Event('error'));

    await expect(settled).rejects.toThrow(/WebSocket connection failed/);
    await flush();
    expect(reconnect).toHaveBeenCalled();
  });

  it('surfaces a refused token refresh as ITSELF, never as an unauthenticated open', async () => {
    const { svc, internals } = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openUnderOldId(svc);
    const expired = new Error('session expired');
    expired.name = 'SessionExpiredError';
    getToken.mockRejectedValueOnce(expired);

    await internals.rotateDeviceIdentity('key', 'saved state lost');

    await expect(svc.gatewaySocketSettled()).rejects.toBe(expired);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a failed reopen with no disconnect handler yet leaves the report to the waiting connection', async () => {
    const { svc, internals } = makeService();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await openUnderOldId(svc);

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();
    const settled = svc.gatewaySocketSettled();
    FakeSocket.all[1].onerror?.(new Event('error'));

    await expect(settled).rejects.toThrow(/WebSocket connection failed/);
    await flush();
    // One report, by `openGatewayConnection`: the reopen itself says it at debug only.
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('rotated id FAILED'));
    expect(console.debug).toHaveBeenCalledWith(
      expect.stringContaining('before any disconnect handler was registered')
    );
  });

  it('does not reopen when the socket closed during the reopen token fetch', async () => {
    const { svc, internals } = makeService();
    const old = await openUnderOldId(svc);
    let releaseToken!: (t: string) => void;
    getToken.mockReturnValueOnce(new Promise<string>((r) => (releaseToken = r)));

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();
    old.readyState = 3;
    releaseToken('late-token');
    await svc.gatewaySocketSettled();

    expect(FakeSocket.all).toHaveLength(1);
  });

  it('refuses a connect whose fence a pause passed during its token fetch', async () => {
    const { svc } = makeService();
    // The reconnect path: the fence is read, the token fetch parks, the app is backgrounded.
    const fence = svc.socketFence();
    svc.pauseSocket();

    await expect(svc.connect('token', fence)).rejects.toBeInstanceOf(GatewayOpenAbandonedError);
    expect(FakeSocket.all).toHaveLength(0);

    // The resume reads a fresh fence and opens.
    const resume = svc.connect('token', svc.socketFence());
    FakeSocket.all[0].open();
    await resume;
    expect(svc.isWsOpen()).toBe(true);
  });

  it('settles a platform open that throws synchronously through the queue, leaving no handle', async () => {
    const { svc } = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'WebSocket',
      class {
        static readonly OPEN = 1;
        constructor() {
          throw new SyntaxError('invalid url');
        }
      }
    );
    const log = vi.mocked(console.log);

    await expect(svc.connect('token', svc.socketFence())).rejects.toBeInstanceOf(SyntaxError);
    await svc.gatewaySocketSettled().catch(() => {});
    log.mockClear();
    svc.pauseSocket();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('open still in flight'));

    vi.stubGlobal('WebSocket', FakeSocket);
    const next = svc.connect('token', svc.socketFence());
    FakeSocket.all[0].open();
    await next;
    expect(svc.isWsOpen()).toBe(true);
  });

  describe('a pause fences the queue', () => {
    it('leaves no socket when it lands during the reopen token fetch', async () => {
      const { svc, internals } = makeService();
      await openUnderOldId(svc);
      let releaseToken!: (t: string) => void;
      getToken.mockReturnValueOnce(new Promise<string>((r) => (releaseToken = r)));

      await internals.rotateDeviceIdentity('key', 'saved state lost');
      await flush();
      svc.pauseSocket();
      releaseToken('late-token');
      await svc.gatewaySocketSettled();
      await flush();

      expect(FakeSocket.all).toHaveLength(1);
      expect(svc.isWsOpen()).toBe(false);
    });

    it('settles a reopen still CONNECTING at once, with no clock, and leaves no socket', async () => {
      const { svc, internals } = makeService();
      await openUnderOldId(svc);
      await internals.rotateDeviceIdentity('key', 'saved state lost');
      await flush();
      const connecting = FakeSocket.all[1];
      expect(connecting.readyState).toBe(0);

      // Fake timers from here: nothing below may need the 15 s deadline to move.
      vi.useFakeTimers();
      const settled = svc.gatewaySocketSettled();
      svc.pauseSocket();

      await expect(settled).rejects.toBeInstanceOf(GatewayOpenAbandonedError);
      expect(connecting.closed).toBe(true);
      expect(svc.isWsOpen()).toBe(false);
      // The abandoned socket opening late changes nothing.
      connecting.onopen?.();
      expect(svc.isWsOpen()).toBe(false);
    });

    it('drops a reopen queued before the pause, and the resume opens under the new id', async () => {
      const { svc, internals } = makeService();
      const handshake = svc.connect('token', svc.socketFence());
      await internals.rotateDeviceIdentity('key', 'saved state lost');
      svc.pauseSocket();
      await expect(handshake).rejects.toBeInstanceOf(GatewayOpenAbandonedError);
      await svc.gatewaySocketSettled();
      expect(FakeSocket.all).toHaveLength(1);

      const resume = svc.connect('token', svc.socketFence());
      FakeSocket.all[1].open();
      await resume;
      expect(FakeSocket.all[1].deviceId).toBe('web-u-new');
    });
  });

  describe('the revoked KeyPackage round', () => {
    function revokedOnce(internals: Internals, order: string[]) {
      let calls = 0;
      internals.generateKeyPackageImpl = vi.fn(async () => {
        calls += 1;
        order.push(`publish-${calls}`);
        if (calls === 1) throw new DeviceRevokedError('web-u-old');
        return { tag: 'kp' };
      });
    }

    it('reopens under the new id, then publishes, then reads the new id queue', async () => {
      const { svc, internals, fetchPending } = makeService();
      await openUnderOldId(svc);
      const order: string[] = [];
      revokedOnce(internals, order);
      fetchPending.mockImplementation(async () => {
        order.push('fetch');
      });

      const round = svc.generateKeyPackage('key');
      await flush();
      // The rotation reopened the socket under the new id, and the republish waits for it.
      expect(FakeSocket.all).toHaveLength(2);
      expect(FakeSocket.all[1].deviceId).toBe('web-u-new');
      expect(order).toEqual(['publish-1']);

      order.push('socket-open');
      FakeSocket.all[1].open();
      await round;

      expect(order).toEqual(['publish-1', 'socket-open', 'fetch', 'publish-2']);
      expect(svc.isWsOpen()).toBe(true);
    });

    it('leaves no socket when paused mid-reopen, and still publishes under the new id', async () => {
      const { svc, internals } = makeService();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await openUnderOldId(svc);
      const order: string[] = [];
      revokedOnce(internals, order);

      const round = svc.generateKeyPackage('key');
      await flush();
      svc.pauseSocket();
      await round;
      await flush();

      expect(order).toEqual(['publish-1', 'publish-2']);
      expect(svc.isWsOpen()).toBe(false);
      expect(FakeSocket.all[1].closed).toBe(true);
    });
  });

  it('refuses to retire an id a socket still carries, in ONE line, and keeps it recorded', async () => {
    const { svc, internals, deleteDevice } = makeService();
    await openUnderOldId(svc);
    // The socket carries the old id while the document holds another: the state the refusal is for.
    internals.deviceId = 'web-u-new';
    recordAbandonedDevice(USER, 'web-u-old');
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    internals.retireAbandonedIds();
    await flush();
    await flush();

    expect(deleteDevice).not.toHaveBeenCalled();
    expect(readAbandonedDeviceIds(USER)).toEqual(['web-u-old']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('still carries it');
  });

  it('queues a second connect behind the first, whose deadline cannot close it', async () => {
    vi.useFakeTimers();
    const { svc } = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = svc.connect('token', svc.socketFence());
    const second = svc.connect('token', svc.socketFence());
    // The second waits: one socket, the first one's.
    expect(FakeSocket.all).toHaveLength(1);

    // The first never opens: its own deadline fails it, and only then does the second start.
    const firstFailed = expect(first).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(15_000);
    await firstFailed;
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].open();
    await second;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeSocket.all[1].closed).toBe(false);
    expect(svc.isWsOpen()).toBe(true);
  });
});

// @vitest-environment happy-dom
/**
 * THE GATEWAY SOCKET FOLLOWS THE DEVICE IDENTITY, AT THE MOMENT THE IDENTITY CHANGES.
 *
 * The login starts its handshake beside the MLS state load (`startGatewayHandshake`), and that load
 * can rotate the device identity (`reenrolLostState`, a credential mismatch). The gateway routes by
 * the `device_id` in the socket URL, so a socket opened under the abandoned id received nothing
 * addressed to the new one until its next reconnect - and the retirement of the old id was signalled
 * (`device_revoked`) to that very socket. Reproduced on a web pre-release 2026-10-25.
 *
 * The real `connect`, `rotateDeviceIdentity` and socket queue run here on a real `WebMlsService`;
 * only the browser socket, the state load and the network are stubbed.
 */
vi.mock('../workers/mlsKeyPackage.worker?worker', () => ({ default: class {} }));
vi.mock('$lib/mls-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAndInitWasm: vi.fn().mockResolvedValue({ tag: 'wasm-client' }),
}));
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getToken: vi.fn().mockResolvedValue('fresh-token'),
}));

import { WebMlsService } from './WebMlsService';
import { readAbandonedDeviceIds } from '$lib/mls-client/abandonedDevices';

const USER = 'u';

/** The browser socket: records its URL, opens or fails only when the test says so. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(): void {}
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
  const reconnect = vi.fn();
  svc.onDisconnect(reconnect);
  return { svc, internals, deleteDevice, reconnect };
}

/** Lets every queued microtask and resolved promise run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the gateway socket across a device identity rotation', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reopens an open socket under the new id, and retires the old id only after', async () => {
    const { svc, internals, deleteDevice, reconnect } = makeService();
    const first = svc.connect('token');
    FakeSocket.all[0].open();
    await first;
    expect(FakeSocket.all[0].deviceId).toBe('web-u-old');

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();

    // The reopen is queued: a second socket, under the NEW id, and the old one closed.
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(FakeSocket.all[1].deviceId).toBe('web-u-new');
    // Not one delete while the only open socket of this document could still carry the old id.
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
    const handshake = svc.connect('token');
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

    const later = svc.connect('token');
    FakeSocket.all[0].open();
    await later;
    expect(FakeSocket.all[0].deviceId).toBe('web-u-new');
  });

  it('reports a failed reopen on the disconnect seam and fails the settle with its own error', async () => {
    const { svc, internals, reconnect } = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = svc.connect('token');
    FakeSocket.all[0].open();
    await first;

    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();
    const settled = svc.gatewaySocketSettled();
    FakeSocket.all[1].onerror?.(new Event('error'));

    await expect(settled).rejects.toThrow(/WebSocket connection failed/);
    await flush();
    expect(reconnect).toHaveBeenCalled();
  });
});

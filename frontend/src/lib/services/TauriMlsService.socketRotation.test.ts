// @vitest-environment happy-dom
/**
 * The native half of the fence `BaseMlsService.socketRotation.test.ts` proves on the browser socket:
 * a device identity rotation reopens the native socket under the new id, and a pause landing while
 * that reopen awaits the plugin's connect leaves NO socket - the native socket that arrives late is
 * released, never assigned, and the queue does not wait for the connect deadline.
 */
const getToken = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
// Every socket open and close reports to the native ring, which asks the document generation:
// answered as the Rust side answers it (`src/test/mocks/pageRingInvoke.ts`).
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: vi.fn((await import('../../test/mocks/pageRingInvoke')).answerPageRing),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));
vi.mock('$lib/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getToken,
}));

import NativeWebSocketModule from '@tauri-apps/plugin-websocket';
import { TauriMlsService } from './TauriMlsService';
import { DeviceRevokedError } from '$lib/mls-client/mlsDeliveryApi';
import { GatewayOpenAbandonedError } from '$lib/mls-client/gatewaySocketOpen';

const NativeWebSocket = NativeWebSocketModule as unknown as { connect: ReturnType<typeof vi.fn> };

interface Internals {
  userId: string;
  deviceId: string;
  delivery: { userId: string; deviceId: string };
  ws: unknown;
  rotateDeviceIdentity(deviceKeyB64: string, reason: string): Promise<string>;
  generateKeyPackageImpl(key: string): Promise<unknown>;
}

function nativeSocket() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn().mockReturnValue(vi.fn()),
  };
}

function makeService() {
  const svc = new TauriMlsService();
  const internals = svc as unknown as Internals;
  internals.userId = 'u';
  internals.deviceId = 'tauri-u-old';
  internals.delivery.deviceId = 'tauri-u-old';
  Object.assign(svc, {
    generateDeviceId: vi.fn().mockReturnValue('tauri-u-new'),
    loadStateWithKey: vi.fn().mockResolvedValue(undefined),
    persistCheckpoint: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(svc, 'deleteDevice').mockResolvedValue({ status: 'deleted' } as Awaited<
    ReturnType<typeof svc.deleteDevice>
  >);
  vi.spyOn(svc, 'fetchPendingMessages').mockResolvedValue(undefined);
  return { svc, internals };
}

const deviceIdOf = (url: string) => new URL(url).searchParams.get('device_id');
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TauriMlsService - the native socket across a rotation and a pause', () => {
  beforeEach(() => {
    NativeWebSocket.connect.mockReset();
    getToken.mockReset().mockResolvedValue('fresh-token');
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reopens under the new id, and a pause during the native connect leaves no socket', async () => {
    const { svc, internals } = makeService();
    const old = nativeSocket();
    NativeWebSocket.connect.mockResolvedValueOnce(old);
    await svc.connect('token', svc.socketFence());
    expect(deviceIdOf(NativeWebSocket.connect.mock.calls[0][0])).toBe('tauri-u-old');

    let arrive!: (ws: unknown) => void;
    NativeWebSocket.connect.mockReturnValueOnce(new Promise((r) => (arrive = r)));
    await internals.rotateDeviceIdentity('key', 'saved state lost');
    await flush();
    expect(deviceIdOf(NativeWebSocket.connect.mock.calls[1][0])).toBe('tauri-u-new');

    const settled = svc.gatewaySocketSettled();
    svc.pauseSocket();
    // Settled by the pause itself, not by the connect deadline.
    await expect(settled).rejects.toBeInstanceOf(GatewayOpenAbandonedError);

    const late = nativeSocket();
    arrive(late);
    await flush();
    expect(late.disconnect).toHaveBeenCalledTimes(1);
    expect(internals.ws).toBeNull();
    expect(svc.isWsOpen()).toBe(false);
  });

  it('a pause then a resume while the old socket is still releasing: the late open clobbers nothing', async () => {
    const { svc, internals } = makeService();
    const first = nativeSocket();
    let released!: () => void;
    first.disconnect.mockReturnValue(new Promise<void>((r) => (released = r)));
    NativeWebSocket.connect.mockResolvedValueOnce(first);
    await svc.connect('token', svc.socketFence());

    // Open A starts: it lets go of `first` and waits for its native release.
    const a = svc.connect('token', svc.socketFence());
    await flush();
    svc.pauseSocket();
    await expect(a).rejects.toBeInstanceOf(GatewayOpenAbandonedError);

    // The resume, B, opens while A is still parked on the release.
    const second = nativeSocket();
    NativeWebSocket.connect.mockResolvedValueOnce(second);
    await svc.connect('token', svc.socketFence());
    expect(internals.ws).toBe(second);

    // A wakes up: it must touch nothing, and open nothing.
    released();
    await flush();
    expect(internals.ws).toBe(second);
    expect(svc.isWsOpen()).toBe(true);
    expect(NativeWebSocket.connect).toHaveBeenCalledTimes(2);
    expect(second.disconnect).not.toHaveBeenCalled();
  });

  it('a revoked KeyPackage round paused mid-reopen publishes under the new id and leaves no socket', async () => {
    const { svc, internals } = makeService();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    NativeWebSocket.connect.mockResolvedValueOnce(nativeSocket());
    await svc.connect('token', svc.socketFence());
    let calls = 0;
    internals.generateKeyPackageImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new DeviceRevokedError('tauri-u-old');
      return { tag: 'kp' };
    });
    let arrive!: (ws: unknown) => void;
    NativeWebSocket.connect.mockReturnValueOnce(new Promise((r) => (arrive = r)));

    const round = svc.generateKeyPackage('key');
    await flush();
    svc.pauseSocket();
    await round;
    arrive(nativeSocket());
    await flush();

    expect(calls).toBe(2);
    expect(internals.deviceId).toBe('tauri-u-new');
    expect(svc.isWsOpen()).toBe(false);
  });
});

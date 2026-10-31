// @vitest-environment happy-dom
/**
 * A DESTROYED CLIENT HOLDS NO NATIVE SOCKET, AND NONE LANDS ON IT LATER.
 *
 * A failed login destroys the client it built (`resetMls`) while the handshake it started beside the
 * state load may still be in its token fetch or its native connect. Unfenced, that open assigned its
 * socket to the destroyed client and started its heartbeat; nothing held the client any more, so no
 * pause and no sign-out could reach the socket, and the plugin kept answering the gateway's pings -
 * the device stayed online as an account that had signed out. Each case below fails on the code
 * before the fence (`BaseMlsService.destroy`).
 */
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
// Every socket open and close reports to the native ring, which asks the document generation:
// answered as the Rust side answers it (`src/test/mocks/pageRingInvoke.ts`).
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: vi.fn((await import('../../test/mocks/pageRingInvoke')).answerPageRing),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import NativeWebSocketModule from '@tauri-apps/plugin-websocket';
import { TauriMlsService } from './TauriMlsService';
import { GatewayOpenAbandonedError } from '$lib/mls-client/gatewaySocketOpen';

const NativeWebSocket = NativeWebSocketModule as unknown as { connect: ReturnType<typeof vi.fn> };

interface Internals {
  deviceId: string;
  ws: unknown;
  heartbeatTimer: unknown;
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
  internals.deviceId = 'tauri-u-dev';
  return { svc, internals };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TauriMlsService - the native socket of a destroyed client', () => {
  beforeEach(() => {
    NativeWebSocket.connect.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a native connect still in flight at the destroy is released when it lands, never assigned', async () => {
    const { svc, internals } = makeService();
    let arrive!: (ws: unknown) => void;
    NativeWebSocket.connect.mockReturnValueOnce(new Promise((r) => (arrive = r)));
    const open = svc.connect('token', svc.socketFence());
    await flush();

    svc.destroy();
    // Settled by the destroy itself, not by the native connect deadline.
    await expect(open).rejects.toBeInstanceOf(GatewayOpenAbandonedError);

    const late = nativeSocket();
    arrive(late);
    await flush();
    expect(late.disconnect).toHaveBeenCalledTimes(1);
    expect(late.addListener).not.toHaveBeenCalled();
    expect(internals.ws).toBeNull();
    expect(internals.heartbeatTimer).toBeNull();
    expect(svc.isWsOpen()).toBe(false);
  });

  it('a handshake whose token fetch spans the destroy opens nothing', async () => {
    const { svc } = makeService();
    // The fence is taken before the token fetch (`startGatewayHandshake`); the destroy lands in it.
    const fence = svc.socketFence();
    svc.destroy();
    await expect(svc.connect('token', fence)).rejects.toBeInstanceOf(GatewayOpenAbandonedError);
    expect(NativeWebSocket.connect).not.toHaveBeenCalled();
  });

  it('an open socket is released with its departure signal at the destroy', async () => {
    const { svc, internals } = makeService();
    const socket = nativeSocket();
    NativeWebSocket.connect.mockResolvedValueOnce(socket);
    await svc.connect('token', svc.socketFence());

    svc.destroy();
    await flush();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'disconnect' }));
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(internals.ws).toBeNull();
  });

  it('no connect opens a socket on a destroyed client, and the attempt is accused', async () => {
    const { svc } = makeService();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.destroy();
    // A fence taken AFTER the destroy matches: only the retirement can refuse this one.
    await expect(svc.connect('token', svc.socketFence())).rejects.toBeInstanceOf(
      GatewayOpenAbandonedError
    );
    expect(NativeWebSocket.connect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('DESTROYED MLS client'));
  });
});

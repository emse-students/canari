// @vitest-environment happy-dom
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
// Every socket open and close reports to the native ring, which asks the document generation:
// answered as the Rust side answers it (`src/test/mocks/pageRingInvoke.ts`).
vi.mock('@tauri-apps/api/core', async () => ({
  invoke: vi.fn((await import('../../test/mocks/pageRingInvoke')).answerPageRing),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { TauriMlsService } from './TauriMlsService';
import { flushMacrotask } from '../../test/flush';

/**
 * A socket the OS closed under a backgrounding app delivers no `Close`, but its `send` rejects and
 * the plugin has already dropped it: `disconnect()` on it can only fail. The send is the probe, so
 * a refused send must not be followed by a native disconnect (and so cannot warn), while an
 * accepted one is released.
 */
interface Internals {
  ws: {
    send: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
  } | null;
  pauseSocket(): void;
  onDisconnect(cb: () => void): void;
  requestReconnectUnlessPaused(trigger: string): boolean;
}

const flush = () => flushMacrotask();

describe('a lifecycle trigger and a paused socket', () => {
  it('stands down while paused - the resume sequence owns the open - and asks otherwise', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const svc = new TauriMlsService() as unknown as Internals;
    const reconnect = vi.fn();
    svc.onDisconnect(reconnect);

    expect(svc.requestReconnectUnlessPaused('app foreground')).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);

    svc.pauseSocket();
    expect(svc.requestReconnectUnlessPaused('app foreground')).toBe(false);
    expect(svc.requestReconnectUnlessPaused('visible again')).toBe(false);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(2);
    debug.mockRestore();
  });
});

describe('TauriMlsService.pauseSocket', () => {
  it('releases a socket whose disconnect frame was accepted', async () => {
    const svc = new TauriMlsService() as unknown as Internals;
    const ws = {
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockReturnValue(vi.fn()),
    };
    svc.ws = ws;
    svc.pauseSocket();
    await flush();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(svc.ws).toBeNull();
  });

  it('does not disconnect, nor warn, when the socket is already closed natively', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new TauriMlsService() as unknown as Internals;
    const ws = {
      send: vi.fn().mockRejectedValue('Trying to work with closed connection'),
      disconnect: vi.fn().mockRejectedValue('Trying to work with closed connection'),
      addListener: vi.fn().mockReturnValue(vi.fn()),
    };
    svc.ws = ws;
    svc.pauseSocket();
    await flush();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not disconnect, nor warn, when a Close lands while the disconnect frame is sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new TauriMlsService() as unknown as Internals;
    let watcher: ((msg: { type: string }) => void) | null = null;
    const unwatch = vi.fn();
    const ws = {
      // The peer's Close is delivered while the send is still pending, then the send resolves.
      send: vi.fn(async () => {
        watcher?.({ type: 'Close' });
      }),
      disconnect: vi.fn().mockRejectedValue('Trying to work with closed connection'),
      addListener: vi.fn((fn: (msg: { type: string }) => void) => {
        watcher = fn;
        return unwatch;
      }),
    };
    svc.ws = ws;
    svc.pauseSocket();
    await flush();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs at info, not warn, when the peer Close lands during the native disconnect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = new TauriMlsService() as unknown as Internals;
    let watcher: ((msg: { type: string }) => void) | null = null;
    const unwatch = vi.fn();
    const ws = {
      send: vi.fn().mockResolvedValue(undefined),
      // The server's reply to the frame arrives while the release runs, which then refuses.
      disconnect: vi.fn(async () => {
        watcher?.({ type: 'Close' });
        throw 'Trying to work with closed connection';
      }),
      addListener: vi.fn((fn: (msg: { type: string }) => void) => {
        watcher = fn;
        return unwatch;
      }),
    };
    svc.ws = ws;
    svc.pauseSocket();
    await flush();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs at info, not warn, when the connection is gone and the refusal beats its Close', async () => {
    // Mi 9T, 2026-11-08, sign-out: the frame was accepted, the peer ended the connection, the
    // plugin forgot it and refused `disconnect()` BEFORE delivering the `Close` the watcher waits for.
    // The gateway no longer ends it on `disconnect` (2026-11-14), but a peer can still end it for
    // its own reason (a release, the network), and the refusal still says so at info.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const svc = new TauriMlsService() as unknown as Internals;
    const unwatch = vi.fn();
    const ws = {
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockRejectedValue('Trying to work with closed connection'),
      addListener: vi.fn().mockReturnValue(unwatch),
    };
    svc.ws = ws;
    svc.pauseSocket();
    await flush();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain(
      'the connection was gone before the native release ran'
    );
    warn.mockRestore();
    log.mockRestore();
  });

  it('is a no-op with no socket', () => {
    const svc = new TauriMlsService() as unknown as Internals;
    expect(() => svc.pauseSocket()).not.toThrow();
  });

  it('releases the socket and its listener channel when the page leaves', async () => {
    // A reload leaves the plugin's Rust-side channel answering a dead page (`Couldn't find
    // callback id`): the page must hand the socket back as it goes.
    const NativeWebSocket = (await import('@tauri-apps/plugin-websocket')).default as unknown as {
      connect: ReturnType<typeof vi.fn>;
    };
    const unlisten = vi.fn();
    const ws = {
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      // The first listener is the session's (`unlisten`), the second the release's short watcher.
      addListener: vi.fn().mockReturnValueOnce(unlisten).mockReturnValue(vi.fn()),
    };
    NativeWebSocket.connect.mockResolvedValue(ws);
    const svc = new TauriMlsService() as unknown as Internals & {
      connect(token: string, fence: number): Promise<void>;
      socketFence(): number;
    };
    await svc.connect('tok', svc.socketFence());
    expect(svc.ws).toBe(ws);

    window.dispatchEvent(new Event('pagehide'));
    await flush();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(svc.ws).toBeNull();
  });

  it('asks for a reconnect on pageshow when the page survived its pagehide', async () => {
    const NativeWebSocket = (await import('@tauri-apps/plugin-websocket')).default as unknown as {
      connect: ReturnType<typeof vi.fn>;
    };
    NativeWebSocket.connect.mockResolvedValue({
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockReturnValue(vi.fn()),
    });
    const svc = new TauriMlsService() as unknown as Internals & {
      connect(token: string, fence: number): Promise<void>;
      socketFence(): number;
      disconnectCallback: (() => void) | null;
      destroy(): void;
    };
    const cb = vi.fn();
    svc.disconnectCallback = cb;
    await svc.connect('tok', svc.socketFence());

    window.dispatchEvent(new Event('pageshow'));
    expect(cb).not.toHaveBeenCalled(); // socket still held: nothing to restore

    window.dispatchEvent(new Event('pagehide'));
    await flush();
    window.dispatchEvent(new Event('pageshow'));
    expect(cb).toHaveBeenCalledTimes(1);

    svc.destroy();
    window.dispatchEvent(new Event('pageshow'));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

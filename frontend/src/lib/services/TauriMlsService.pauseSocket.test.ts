// @vitest-environment happy-dom
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
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
  ws: { send: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } | null;
  pauseSocket(): void;
}

const flush = () => flushMacrotask();

describe('TauriMlsService.pauseSocket', () => {
  it('releases a socket whose disconnect frame was accepted', async () => {
    const svc = new TauriMlsService() as unknown as Internals;
    const ws = {
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
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
    };
    svc.ws = ws;
    svc.pauseSocket();
    await flush();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
      addListener: vi.fn().mockReturnValue(unlisten),
    };
    NativeWebSocket.connect.mockResolvedValue(ws);
    const svc = new TauriMlsService() as unknown as Internals & {
      connect(token?: string): Promise<void>;
    };
    await svc.connect('tok');
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
      connect(token?: string): Promise<void>;
      disconnectCallback: (() => void) | null;
      destroy(): void;
    };
    const cb = vi.fn();
    svc.disconnectCallback = cb;
    await svc.connect('tok');

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

vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

import { TauriMlsService } from './TauriMlsService';

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

const flush = () => new Promise((r) => setTimeout(r, 0));

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
});

import { describe, expect, it } from 'vitest';
import type { Channel } from '@tauri-apps/api/core';
import {
  nativeEnd,
  tauriSocketTransport,
  type NativeSocketBridge,
  type NativeSocketEnd,
} from './tauriSocketTransport';
import type { TransportEnd } from './transport';

/** A bridge whose native side the test plays. */
class FakeBridge implements NativeSocketBridge {
  onData: Channel<ArrayBuffer> | null = null;
  onEnd: Channel<NativeSocketEnd> | null = null;
  writes: { id: number; bytes: Uint8Array }[] = [];
  closes: number[] = [];
  closeAlls = 0;
  /** What happened, in order: `closeAll` and `open`. */
  calls: string[] = [];
  refuseOpen: unknown = null;
  refuseWrite = false;

  async open(onData: Channel<ArrayBuffer>, onEnd: Channel<NativeSocketEnd>): Promise<number> {
    this.calls.push('open');
    if (this.refuseOpen) throw this.refuseOpen;
    this.onData = onData;
    this.onEnd = onEnd;
    return 7;
  }
  async write(id: number, bytes: Uint8Array): Promise<void> {
    if (this.refuseWrite) throw { kind: 'unknown_socket' };
    this.writes.push({ id, bytes });
  }
  async close(id: number): Promise<void> {
    this.closes.push(id);
  }
  async closeAll(): Promise<number> {
    this.closeAlls++;
    this.calls.push('closeAll');
    return 2;
  }
  newChannel<T>(): Channel<T> {
    return { onmessage: () => {} } as unknown as Channel<T>;
  }
}

function handlers() {
  const received: number[][] = [];
  const ends: TransportEnd[] = [];
  return {
    received,
    ends,
    handlers: {
      onBytes: (b: Uint8Array) => received.push([...b]),
      onEnd: (e: TransportEnd) => ends.push(e),
    },
  };
}

describe('nativeEnd', () => {
  it("maps the Rust side's tagged end", () => {
    expect(nativeEnd({ reason: 'peer_closed' })).toEqual({ kind: 'peer_closed' });
    expect(nativeEnd({ reason: 'closed_by_page' })).toEqual({ kind: 'closed_by_us' });
    expect(nativeEnd({ reason: 'read_failed', detail: 'reset' })).toEqual({
      kind: 'failed',
      detail: 'read_failed: reset',
    });
  });
});

describe('tauriSocketTransport', () => {
  it("closes the previous document's sockets once, before this document's first open", async () => {
    const bridge = new FakeBridge();
    const open = tauriSocketTransport(bridge);
    await open(handlers().handlers);
    await open(handlers().handlers);
    expect(bridge.closeAlls).toBe(1);
    expect(bridge.calls).toEqual(['closeAll', 'open', 'open']);
  });

  it('writes raw bytes to its socket id and hands received bytes over', async () => {
    const bridge = new FakeBridge();
    const h = handlers();
    const transport = await tauriSocketTransport(bridge)(h.handlers);
    await transport.send(new Uint8Array([22, 3, 1]));
    expect(bridge.writes).toEqual([{ id: 7, bytes: new Uint8Array([22, 3, 1]) }]);
    bridge.onData!.onmessage(new Uint8Array([23, 3, 3]).buffer);
    expect(h.received).toEqual([[23, 3, 3]]);
  });

  it('an open refused natively is unreachable', async () => {
    const bridge = new FakeBridge();
    bridge.refuseOpen = { kind: 'connect_failed', detail: 'timed out' };
    await expect(tauriSocketTransport(bridge)(handlers().handlers)).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('ends once; after the end a send is refused and close does nothing', async () => {
    const bridge = new FakeBridge();
    const h = handlers();
    const transport = await tauriSocketTransport(bridge)(h.handlers);
    bridge.onEnd!.onmessage({ reason: 'peer_closed' });
    bridge.onEnd!.onmessage({ reason: 'closed_by_page' });
    bridge.onData!.onmessage(new Uint8Array([1]).buffer);
    expect(h.ends).toEqual([{ kind: 'peer_closed' }]);
    expect(h.received).toEqual([]);
    await expect(transport.send(new Uint8Array([1]))).rejects.toMatchObject({ kind: 'closed' });
    transport.close();
    expect(bridge.closes).toEqual([]);
  });

  it('close asks the native side to close its socket; a refused write is closed', async () => {
    const bridge = new FakeBridge();
    const transport = await tauriSocketTransport(bridge)(handlers().handlers);
    transport.close();
    expect(bridge.closes).toEqual([7]);
    bridge.refuseWrite = true;
    await expect(transport.send(new Uint8Array([1]))).rejects.toMatchObject({ kind: 'closed' });
  });
});

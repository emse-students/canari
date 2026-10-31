import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module per test: the document generation is asked once per document (module). */
async function freshModule() {
  vi.resetModules();
  return import('./pageGatewaySocket');
}

/** A native side answering `document` for the generation and recording every statement. */
function nativeSide(document: unknown = 7) {
  return vi.fn(async (command: string) =>
    command === 'page_ring_document' ? document : undefined
  );
}

describe('the statements of the page to the native ring', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names its document in every statement, asking for it once', async () => {
    const mod = await freshModule();
    const invokeFn = nativeSide(7);
    mod.reportPageGatewaySocket('mls-service-1', true, invokeFn);
    mod.reportPageRingingCall('call-service-2', 'call-1', invokeFn);
    mod.reportPageRingingCall('call-service-2', null, invokeFn);
    mod.reportPageGatewaySocket('mls-service-1', false, invokeFn);
    await vi.waitFor(() => expect(invokeFn).toHaveBeenCalledTimes(5));
    expect(invokeFn.mock.calls).toEqual([
      [mod.PAGE_RING_DOCUMENT_COMMAND],
      [mod.SET_PAGE_GATEWAY_SOCKET_COMMAND, { holder: 'mls-service-1', held: true, document: 7 }],
      [
        mod.SET_PAGE_RINGING_CALL_COMMAND,
        { holder: 'call-service-2', callId: 'call-1', document: 7 },
      ],
      [mod.SET_PAGE_RINGING_CALL_COMMAND, { holder: 'call-service-2', callId: null, document: 7 }],
      [mod.SET_PAGE_GATEWAY_SOCKET_COMMAND, { holder: 'mls-service-1', held: false, document: 7 }],
    ]);
  });

  it('keeps the order of its statements while the generation is still being asked', async () => {
    const mod = await freshModule();
    let answer: (n: number) => void = () => {};
    const sent: unknown[] = [];
    const invokeFn = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === mod.PAGE_RING_DOCUMENT_COMMAND)
        return new Promise<number>((r) => (answer = r));
      sent.push(args?.held);
      return undefined;
    });
    mod.reportPageGatewaySocket('h', true, invokeFn);
    mod.reportPageGatewaySocket('h', false, invokeFn);
    mod.reportPageGatewaySocket('h', true, invokeFn);
    expect(sent).toEqual([]);
    answer(3);
    await vi.waitFor(() => expect(sent).toEqual([true, false, true]));
  });

  it('a refused statement is logged, never thrown and never retried, and the next one still leaves', async () => {
    const mod = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let first = true;
    const invokeFn = vi.fn(async (command: string) => {
      if (command === mod.PAGE_RING_DOCUMENT_COMMAND) return 1;
      if (first) {
        first = false;
        throw new Error('no such command');
      }
      return undefined;
    });
    expect(() => mod.reportPageGatewaySocket('h', true, invokeFn)).not.toThrow();
    mod.reportPageRingingCall('c', 'call-1', invokeFn);
    await vi.waitFor(() => expect(invokeFn).toHaveBeenCalledTimes(3));
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('held=true');
  });

  it('a generation it cannot learn sends nothing and says so at every statement', async () => {
    const mod = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invokeFn = nativeSide('not a number');
    mod.reportPageGatewaySocket('h', true, invokeFn);
    mod.reportPageRingingCall('c', 'call-1', invokeFn);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(invokeFn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('document generation is not a number');
  });

  it('hands every owner its own holder id, named for its kind', async () => {
    const mod = await freshModule();
    const one = mod.nextPageRingHolder('mls-service');
    const two = mod.nextPageRingHolder('call-service');
    expect(one).not.toBe(two);
    expect(one.startsWith('mls-service-')).toBe(true);
    expect(two.startsWith('call-service-')).toBe(true);
  });

  it('are the commands the Rust side registers, with the same arguments', async () => {
    const mod = await freshModule();
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, '../../../src-tauri/src/page_ring.rs'), 'utf8');
    const libRs = readFileSync(resolve(here, '../../../src-tauri/src/lib.rs'), 'utf8');
    expect(rust).toContain(`pub(crate) fn ${mod.PAGE_RING_DOCUMENT_COMMAND}() -> u64`);
    expect(rust).toContain(
      `pub(crate) fn ${mod.SET_PAGE_GATEWAY_SOCKET_COMMAND}(document: u64, holder: String, held: bool)`
    );
    // `callId` from the page is Tauri's camelCase of `call_id`.
    expect(rust).toContain(
      `pub(crate) fn ${mod.SET_PAGE_RINGING_CALL_COMMAND}(document: u64, holder: String, call_id: Option<String>)`
    );
    for (const command of [
      mod.PAGE_RING_DOCUMENT_COMMAND,
      mod.SET_PAGE_GATEWAY_SOCKET_COMMAND,
      mod.SET_PAGE_RINGING_CALL_COMMAND,
    ]) {
      expect(libRs).toContain(`page_ring::${command},`);
    }
  });
});

describe('the socket setter of TauriMlsService reports transitions only, under its own holder', () => {
  it('reports a change and stays silent on a repeat; two instances are two holders', async () => {
    vi.resetModules();
    const report = vi.fn();
    let n = 0;
    vi.doMock('./pageGatewaySocket', () => ({
      reportPageGatewaySocket: report,
      nextPageRingHolder: () => `h${++n}`,
    }));
    const { TauriMlsService } = await import('./TauriMlsService');
    const one = new TauriMlsService() as unknown as { ws: object | null };
    const two = new TauriMlsService() as unknown as { ws: object | null };
    const socket = {};
    one.ws = socket;
    one.ws = socket;
    two.ws = socket;
    one.ws = null;
    one.ws = null;
    expect(report.mock.calls).toEqual([
      ['h1', true],
      ['h2', true],
      ['h1', false],
    ]);
    vi.doUnmock('./pageGatewaySocket');
    // A COLD import of the whole TauriMlsService graph after `resetModules` (measured 5.6 s on a
    // Windows workstation, over the 5 s default): the assertions above are on order, never on time.
  }, 30_000);
});

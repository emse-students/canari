import { describe, expect, it, vi } from 'vitest';
import { reportPageGatewaySocket, SET_PAGE_GATEWAY_SOCKET_COMMAND } from './pageGatewaySocket';

describe('reportPageGatewaySocket', () => {
  it('states the socket to the native side, held or not', () => {
    const invokeFn = vi.fn().mockResolvedValue(undefined);
    reportPageGatewaySocket(true, invokeFn);
    reportPageGatewaySocket(false, invokeFn);
    expect(invokeFn.mock.calls).toEqual([
      [SET_PAGE_GATEWAY_SOCKET_COMMAND, { held: true }],
      [SET_PAGE_GATEWAY_SOCKET_COMMAND, { held: false }],
    ]);
  });

  it('a refused statement is logged, never thrown and never retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invokeFn = vi.fn().mockRejectedValue(new Error('no such command'));
    expect(() => reportPageGatewaySocket(true, invokeFn)).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(String(warn.mock.calls[0][0])).toContain('held=true');
    expect(invokeFn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('is the command the Rust side registers', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, '../../../src-tauri/src/page_ring.rs'), 'utf8');
    expect(rust).toContain(`pub(crate) fn ${SET_PAGE_GATEWAY_SOCKET_COMMAND}(held: bool)`);
  });
});

describe('the socket setter of TauriMlsService reports transitions only', () => {
  it('reports a change and stays silent on a repeat', async () => {
    vi.resetModules();
    const report = vi.fn();
    vi.doMock('./pageGatewaySocket', () => ({ reportPageGatewaySocket: report }));
    const { TauriMlsService } = await import('./TauriMlsService');
    const svc = new TauriMlsService() as unknown as { ws: object | null };
    const socket = {};
    svc.ws = socket;
    svc.ws = socket;
    svc.ws = null;
    svc.ws = null;
    expect(report.mock.calls).toEqual([[true], [false]]);
    vi.doUnmock('./pageGatewaySocket');
  });
});

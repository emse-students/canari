import { describe, expect, it, vi } from 'vitest';
import {
  nextGatewaySocketHolder,
  reportPageGatewaySocket,
  SET_PAGE_GATEWAY_SOCKET_COMMAND,
} from './pageGatewaySocket';

describe('reportPageGatewaySocket', () => {
  it('states the socket of one holder to the native side, held or not', () => {
    const invokeFn = vi.fn().mockResolvedValue(undefined);
    reportPageGatewaySocket('mls-service-1', true, invokeFn);
    reportPageGatewaySocket('mls-service-1', false, invokeFn);
    expect(invokeFn.mock.calls).toEqual([
      [SET_PAGE_GATEWAY_SOCKET_COMMAND, { holder: 'mls-service-1', held: true }],
      [SET_PAGE_GATEWAY_SOCKET_COMMAND, { holder: 'mls-service-1', held: false }],
    ]);
  });

  it('a refused statement is logged, never thrown and never retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invokeFn = vi.fn().mockRejectedValue(new Error('no such command'));
    expect(() => reportPageGatewaySocket('h', true, invokeFn)).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(String(warn.mock.calls[0][0])).toContain('held=true');
    expect(invokeFn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('hands every owner its own holder id', () => {
    expect(nextGatewaySocketHolder()).not.toBe(nextGatewaySocketHolder());
  });

  it('is the command the Rust side registers, with the same arguments', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, '../../../src-tauri/src/page_ring.rs'), 'utf8');
    expect(rust).toContain(
      `pub(crate) fn ${SET_PAGE_GATEWAY_SOCKET_COMMAND}(holder: String, held: bool)`
    );
  });
});

describe('the socket setter of TauriMlsService reports transitions only, under its own holder', () => {
  it('reports a change and stays silent on a repeat; two instances are two holders', async () => {
    vi.resetModules();
    const report = vi.fn();
    let n = 0;
    vi.doMock('./pageGatewaySocket', () => ({
      reportPageGatewaySocket: report,
      nextGatewaySocketHolder: () => `h${++n}`,
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
  });
});

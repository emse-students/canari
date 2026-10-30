import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

const { copyText } = await import('./clipboard');

function stubClipboard(clipboard: unknown) {
  vi.stubGlobal('navigator', { clipboard });
}

describe('copyText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the exact text and confirms with an info toast', async () => {
    const writeText = vi.fn(async (_t: string) => {});
    stubClipboard({ writeText });
    expect(await copyText('https://x/y#frag', { what: 'link' })).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('https://x/y#frag');
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('picks a different confirmation for each kind', async () => {
    stubClipboard({ writeText: async () => {} });
    const seen = new Set<string>();
    for (const what of ['link', 'code', 'text', 'id'] as const) {
      showToast.mockClear();
      await copyText('v', { what });
      seen.add(String(showToast.mock.calls[0][0]));
    }
    expect(seen.size).toBe(4);
  });

  it('skips the success toast when silent, never the failure one', async () => {
    stubClipboard({ writeText: async () => {} });
    await copyText('v', { what: 'text', silent: true });
    expect(showToast).not.toHaveBeenCalled();

    stubClipboard({
      writeText: async () => {
        throw new Error('denied');
      },
    });
    await copyText('v', { what: 'text', silent: true });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('reports a refused write as `refused` with an error toast and no confirmation', async () => {
    stubClipboard({
      writeText: async () => {
        throw new DOMException('Document is not focused', 'NotAllowedError');
      },
    });
    expect(await copyText('v', { what: 'link' })).toEqual({ ok: false, reason: 'refused' });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('reports a context with no clipboard as `unavailable` with an error toast', async () => {
    stubClipboard(undefined);
    expect(await copyText('v', { what: 'code' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

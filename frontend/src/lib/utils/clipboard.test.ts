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

  it('hands a promised text to a ClipboardItem synchronously, inside the gesture', async () => {
    const written: unknown[] = [];
    const write = vi.fn(async (items: unknown[]) => {
      written.push(...items);
    });
    stubClipboard({ write, writeText: vi.fn() });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public items: Record<string, Promise<Blob>>) {}
      }
    );
    let resolve!: (t: string) => void;
    const text = new Promise<string>((r) => (resolve = r));
    const pending = copyText(text, { what: 'link' });
    // Called before the text resolved: that is what keeps WebKit's gesture alive.
    expect(write).toHaveBeenCalledTimes(1);
    resolve('https://x/g/join/t');
    expect(await pending).toEqual({ ok: true });
    const blob = await (written[0] as { items: Record<string, Promise<Blob>> }).items['text/plain'];
    expect(await blob.text()).toBe('https://x/g/join/t');
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('rethrows the failure of a promised text and shows no copy-failed toast', async () => {
    stubClipboard({
      write: async (items: { items: Record<string, Promise<Blob>> }[]) => {
        await items[0].items['text/plain'];
      },
    });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public items: Record<string, Promise<Blob>>) {}
      }
    );
    await expect(
      copyText(Promise.reject(new Error('mint failed')), { what: 'link' })
    ).rejects.toThrow('mint failed');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('reports a promised text without ClipboardItem support as unavailable', async () => {
    stubClipboard({ writeText: async () => {} });
    vi.stubGlobal('ClipboardItem', undefined);
    expect(await copyText(Promise.resolve('v'), { what: 'link' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('reports a context with no clipboard as `unavailable` with an error toast', async () => {
    stubClipboard(undefined);
    expect(await copyText('v', { what: 'code' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

import { saveObjectUrlAs } from './fileDownload';

const save = vi.fn();
const writeFile = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => save(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: (...args: unknown[]) => writeFile(...args),
}));

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

/** Makes `isTauriRuntime()` answer `true` for the duration of a test. */
function pretendTauri(bytes: Uint8Array) {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  globalThis.fetch = vi.fn(async () => ({
    arrayBuffer: async () => bytes.buffer,
  })) as unknown as typeof fetch;
}

describe('saveObjectUrlAs', () => {
  beforeEach(() => {
    save.mockReset();
    writeFile.mockReset();
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('uses an anchor download in a real browser', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const created: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') created.push(el as HTMLAnchorElement);
      return el;
    });

    await expect(saveObjectUrlAs('blob:x', 'rapport.pdf')).resolves.toBe(true);

    expect(click).toHaveBeenCalledOnce();
    expect(created[0].download).toBe('rapport.pdf');
    vi.restoreAllMocks();
  });

  it('writes through the native save dialog on Tauri, where an anchor does nothing', async () => {
    // This is the whole point of the module: Tauri installs no download handler, so the web
    // path is silently a no-op on Android and iOS.
    const bytes = new Uint8Array([1, 2, 3, 4]);
    pretendTauri(bytes);
    save.mockResolvedValue('content://downloads/rapport.pdf');

    await expect(saveObjectUrlAs('blob:x', 'rapport.pdf')).resolves.toBe(true);

    expect(save).toHaveBeenCalledWith({ defaultPath: 'rapport.pdf' });
    expect(writeFile).toHaveBeenCalledOnce();
    const [target, written] = writeFile.mock.calls[0];
    expect(target).toBe('content://downloads/rapport.pdf');
    expect(Array.from(written as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it('writes nothing when the user cancels the dialog', async () => {
    pretendTauri(new Uint8Array([9]));
    save.mockResolvedValue(null);

    await expect(saveObjectUrlAs('blob:x', 'rapport.pdf')).resolves.toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });
});

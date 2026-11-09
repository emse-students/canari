// @vitest-environment happy-dom
import {
  fileExtension,
  isProviderDocument,
  saveDialogFilters,
  saveObjectUrlAs,
} from './fileDownload';

const save = vi.fn();
const writeFile = vi.fn();
const invoke = vi.fn();
const stageBlob = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...args: unknown[]) => save(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: (...args: unknown[]) => writeFile(...args),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('$lib/reels/gallery', () => ({ stageBlob: (...args: unknown[]) => stageBlob(...args) }));

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
    invoke.mockReset();
    stageBlob.mockReset();
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
    save.mockResolvedValue('/var/mobile/Containers/Data/rapport.pdf');

    await expect(saveObjectUrlAs('blob:x', 'rapport.pdf')).resolves.toBe(true);

    expect(save).toHaveBeenCalledWith({
      defaultPath: 'rapport.pdf',
      filters: [{ name: 'pdf', extensions: ['pdf'] }],
    });
    expect(writeFile).toHaveBeenCalledOnce();
    const [target, written] = writeFile.mock.calls[0];
    expect(target).toBe('/var/mobile/Containers/Data/rapport.pdf');
    expect(Array.from(written as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes an Android document through the provider's own stream, never plugin-fs", async () => {
    // The reported defect: plugin-fs detaches the descriptor, the Downloads provider records a
    // size of 0, and the file is refused when shared from there.
    pretendTauri(new Uint8Array([1, 2, 3, 4]));
    const uri = 'content://com.android.providers.downloads.documents/document/msf%3A121';
    save.mockResolvedValue(uri);
    invoke.mockResolvedValue({ written: 4 });

    await expect(saveObjectUrlAs('blob:x', 'canari-log.txt')).resolves.toBe(true);

    expect(writeFile).not.toHaveBeenCalled();
    expect(stageBlob).toHaveBeenCalledOnce();
    const [session, staged] = stageBlob.mock.calls[0] as [string, Blob];
    expect(staged.size).toBe(4);
    expect(invoke).toHaveBeenCalledWith('plugin:gallery|write_staged_document', { session, uri });
  });

  it('discards the staged copy and rejects when staging fails', async () => {
    pretendTauri(new Uint8Array([1]));
    save.mockResolvedValue('content://com.android.externalstorage.documents/document/x');
    stageBlob.mockRejectedValue(new Error('disk full'));
    invoke.mockResolvedValue(undefined);

    await expect(saveObjectUrlAs('blob:x', 'a.txt')).rejects.toThrow('disk full');

    expect(invoke).toHaveBeenCalledWith('plugin:gallery|discard_video', {
      session: expect.any(String),
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'plugin:gallery|write_staged_document',
      expect.anything()
    );
  });

  it('discards the staged copy and rejects when the document write is refused', async () => {
    // A rejection before the command runs (IPC, permission) leaves the staged copy behind.
    pretendTauri(new Uint8Array([1]));
    save.mockResolvedValue('content://com.android.externalstorage.documents/document/x');
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'plugin:gallery|write_staged_document') throw new Error('not allowed');
      return undefined;
    });

    await expect(saveObjectUrlAs('blob:x', 'a.txt')).rejects.toThrow('not allowed');

    const [session] = stageBlob.mock.calls[0] as [string, Blob];
    expect(invoke).toHaveBeenCalledWith('plugin:gallery|discard_video', { session });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('writes nothing when the user cancels the dialog', async () => {
    pretendTauri(new Uint8Array([9]));
    save.mockResolvedValue(null);

    await expect(saveObjectUrlAs('blob:x', 'rapport.pdf')).resolves.toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('isProviderDocument', () => {
  it('tells an Android document from a path', () => {
    expect(isProviderDocument('content://com.android.providers.downloads.documents/x')).toBe(true);
    expect(isProviderDocument('/var/mobile/Containers/Data/a.txt')).toBe(false);
    expect(isProviderDocument('/home/a/Downloads/a.txt')).toBe(false);
    expect(isProviderDocument('file:///tmp/a.txt')).toBe(false);
  });
});

describe('fileExtension / saveDialogFilters', () => {
  // The reported file: its second save came out as "... .mp3 (1)" because the dialog carried no
  // type matching the extension.
  const hymne = 'Hymne \u00e0 la Nouvelle \u00c9cole.mp3';

  it('reads the extension of the reported file', () => {
    expect(fileExtension(hymne)).toBe('mp3');
    expect(saveDialogFilters(hymne)).toEqual([{ name: 'mp3', extensions: ['mp3'] }]);
  });

  it('sends the log file the text type: txt is the filter the dialog resolves to text/plain', () => {
    expect(saveDialogFilters('canari-log-1.6.6-20261107-1200.txt')).toEqual([
      { name: 'txt', extensions: ['txt'] },
    ]);
  });

  it('takes the last extension of a multi-dot name, an existing counter included', () => {
    expect(fileExtension('a.tar.gz')).toBe('gz');
    expect(fileExtension('photo (1).jpg')).toBe('jpg');
  });

  it('gives no filter to a name without an extension', () => {
    for (const name of ['Makefile', '.bashrc', 'name.', '']) {
      expect(fileExtension(name)).toBeNull();
      expect(saveDialogFilters(name)).toEqual([]);
    }
  });
});

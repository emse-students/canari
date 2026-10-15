import { describe, expect, it, vi } from 'vitest';
import { mimeForPickedName, pickNatively, pickedFileName } from './nativeAttachPicker';

const dialogOpen = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogOpen }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('pickNatively - what is read', () => {
  it('a caller keeping ONE file gets a one-file picker, so nothing it would drop is ever read', async () => {
    dialogOpen.mockResolvedValue('file:///Library/Caches/clip.mov');
    invoke.mockResolvedValue(new ArrayBuffer(2));

    const files = await pickNatively('library', { single: true });

    expect(dialogOpen).toHaveBeenCalledWith({ multiple: false, pickerMode: 'media' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(files.map((f) => f.name)).toEqual(['clip.mov']);
  });

  it('the composers still pick several', async () => {
    dialogOpen.mockResolvedValue(null);
    await pickNatively('library');
    expect(dialogOpen).toHaveBeenLastCalledWith({ multiple: true, pickerMode: 'media' });
  });
});

describe('nativeAttachPicker - naming what a native picker copied', () => {
  it('takes the last segment of a file URL, decoded', () => {
    expect(pickedFileName('file:///private/var/mobile/Library/Caches/IMG%200001.HEIC')).toBe(
      'IMG 0001.HEIC'
    );
  });

  it('types a file from its extension, case-insensitively, and leaves an unknown one empty', () => {
    expect(mimeForPickedName('IMG_0001.HEIC')).toBe('image/heic');
    expect(mimeForPickedName('clip.MOV')).toBe('video/quicktime');
    expect(mimeForPickedName('notes.pdf')).toBe('application/pdf');
    expect(mimeForPickedName('archive.rar')).toBe('');
    expect(mimeForPickedName('README')).toBe('');
  });
});

/**
 * SOURCE PIN, because no gate sees it: a command missing from `generate_handler!` compiles, and the
 * iOS library would then reject on the phone with "command take_picked_file not found" - only on
 * hardware, only after a pick.
 */
describe('take_picked_file is reachable from the page', () => {
  it('is registered with the invoke handler', async () => {
    const { readFileSync } = await import('node:fs');
    const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
    const handler = lib.slice(lib.indexOf('generate_handler!['));
    expect(handler.slice(0, handler.indexOf(']'))).toMatch(/\btake_picked_file,/);
    expect(lib).toMatch(/use crate::commands::picked_files::take_picked_file;/);
  });
});

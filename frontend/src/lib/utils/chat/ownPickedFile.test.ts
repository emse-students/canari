import { describe, expect, it } from 'vitest';
import { ownPickedFile, PickedFileUnreadableError } from './ownPickedFile';

/**
 * A `File` whose `arrayBuffer()` answers as an Android WebView's `content://` view did for the
 * member of the P1 (1.8.1): it REPORTS a size, and reads back what `read` says.
 */
function contentView(reported: number, read: () => Promise<ArrayBuffer>): File {
  const file = new File([new Uint8Array(reported)], 'IMG_0001.jpg', {
    type: 'image/jpeg',
    lastModified: 1_700_000_000_000,
  });
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  return file;
}

describe('ownPickedFile', () => {
  it('returns a File backed by the bytes read, with the same name, type and date', async () => {
    const picked = new File([new Uint8Array([1, 2, 3, 4])], 'a.png', {
      type: 'image/png',
      lastModified: 42,
    });
    const owned = await ownPickedFile(picked);
    expect(owned).not.toBe(picked);
    expect(owned.name).toBe('a.png');
    expect(owned.type).toBe('image/png');
    expect(owned.lastModified).toBe(42);
    expect(Array.from(new Uint8Array(await owned.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('owns its bytes: a source that reads empty LATER no longer matters', async () => {
    let reads = 0;
    const view = contentView(3, async () => {
      reads += 1;
      // The first read (at the pick) is the photo; any later one (the Send tap) is the lapsed view.
      return reads === 1 ? new Uint8Array([9, 8, 7]).buffer : new ArrayBuffer(0);
    });
    const owned = await ownPickedFile(view);
    expect(owned.size).toBe(3);
    expect(new Uint8Array(await owned.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(reads).toBe(1);
  });

  it('takes the size READ, not the size reported', async () => {
    const view = contentView(0, async () => new Uint8Array(1234).buffer);
    expect((await ownPickedFile(view)).size).toBe(1234);
  });

  it('refuses a file that reads EMPTY, typed `empty`, whatever size it reported', async () => {
    const view = contentView(305207, async () => new ArrayBuffer(0));
    const error = await ownPickedFile(view).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PickedFileUnreadableError);
    expect((error as PickedFileUnreadableError).reason).toBe('empty');
    expect((error as PickedFileUnreadableError).reportedSize).toBe(305207);
  });

  it('refuses a file whose read throws, typed `unreadable`, with the platform error as cause', async () => {
    const denied = new DOMException('permission lapsed', 'NotReadableError');
    const view = contentView(10, () => Promise.reject(denied));
    const error = await ownPickedFile(view).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PickedFileUnreadableError);
    expect((error as PickedFileUnreadableError).reason).toBe('unreadable');
    expect((error as PickedFileUnreadableError).cause).toBe(denied);
  });

  it('refuses a genuinely empty file', async () => {
    const error = await ownPickedFile(new File([], 'empty.txt')).catch((e: unknown) => e);
    expect((error as PickedFileUnreadableError).reason).toBe('empty');
  });
});

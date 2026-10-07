import { describe, expect, it, vi } from 'vitest';
import { canvasToBlob, dataUrlToBlob } from './canvasBlob';

describe('dataUrlToBlob', () => {
  it('decodes the bytes and keeps the mime type the engine answered', async () => {
    const blob = dataUrlToBlob(`data:image/jpeg;base64,${btoa('ÿØabc')}`);
    expect(blob?.type).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await blob!.arrayBuffer()))).toEqual([
      0xff, 0xd8, 0x61, 0x62, 0x63,
    ]);
  });

  it('answers null for anything that is not a base64 data URL', () => {
    expect(dataUrlToBlob('data:,')).toBeNull();
    expect(dataUrlToBlob('blob:nope')).toBeNull();
  });
});

describe('canvasToBlob', () => {
  it('encodes through toDataURL and never through the idle-scheduled toBlob', () => {
    const canvas = document.createElement('canvas');
    const toBlob = vi.spyOn(canvas, 'toBlob');
    const toDataURL = vi
      .spyOn(canvas, 'toDataURL')
      .mockReturnValue(`data:image/jpeg;base64,${btoa('jpeg')}`);
    const blob = canvasToBlob(canvas, 'image/jpeg', 0.92);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.92);
    expect(toBlob).not.toHaveBeenCalled();
    expect(blob?.size).toBe(4);
  });

  it('answers null, logged, for a canvas that encodes nothing', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:,');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(canvasToBlob(canvas, 'image/png')).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

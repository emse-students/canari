import { describe, expect, it } from 'vitest';
import { rgbaToThumbHash } from 'thumbhash';
import { placeholderDataUrl } from './mediaPlaceholder';
import { toBase64 } from './hex';

/** A 4x3 amber image, hashed the way the sender hashes a picture. */
function amberHash(): string {
  const rgba = new Uint8Array(4 * 3 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([245, 158, 11, 255], i);
  return toBase64(rgbaToThumbHash(4, 3, rgba));
}

describe('mediaPlaceholder', () => {
  it('is a few dozen bytes - small enough to ride in every media message', () => {
    expect(atob(amberHash()).length).toBeLessThanOrEqual(30);
  });

  it('decodes a sender hash to a PNG the frame can paint', () => {
    expect(placeholderDataUrl(amberHash())).toMatch(/^data:image\/png;base64,/);
  });

  it('paints nothing for none, and drops an undecodable one rather than throwing', () => {
    expect(placeholderDataUrl(undefined)).toBeNull();
    expect(placeholderDataUrl('')).toBeNull();
    expect(placeholderDataUrl('%%% not base64 %%%')).toBeNull();
  });
});

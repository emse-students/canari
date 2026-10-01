/**
 * `parseByteRange` - what the segmented media reader sends, and what it must get back.
 *
 * The reader opens a blob with ONE request for "the header and a full first segment" without
 * knowing the file's length, so the clamp of an end past the object is the case everything else
 * stands on; a range starting past the end is how a TRUNCATED blob is seen.
 */
import { parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  const SIZE = 1000;

  it('serves the whole object when there is no Range header', () => {
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('', SIZE)).toEqual({ kind: 'whole' });
  });

  it('serves a closed range as a part', () => {
    expect(parseByteRange('bytes=0-19', SIZE)).toEqual({ kind: 'partial', start: 0, end: 19 });
    expect(parseByteRange('bytes=20-535', SIZE)).toEqual({ kind: 'partial', start: 20, end: 535 });
  });

  it('clamps an end past the object to its last byte', () => {
    expect(parseByteRange('bytes=0-1048595', SIZE)).toEqual({
      kind: 'partial',
      start: 0,
      end: SIZE - 1,
    });
  });

  it('serves an open range to the end, and a suffix range', () => {
    expect(parseByteRange('bytes=900-', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('answers unsatisfiable when the range starts at or past the end - a truncated blob', () => {
    expect(parseByteRange('bytes=1000-1999', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores what it does not serve as a part: several ranges, another unit, a reversed range', () => {
    expect(parseByteRange('bytes=0-1,5-9', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('items=0-1', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('bytes=9-2', SIZE)).toEqual({ kind: 'whole' });
    expect(parseByteRange('bytes=-', SIZE)).toEqual({ kind: 'whole' });
  });
});

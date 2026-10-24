import { parseVoipTokenField } from './voip-token';

describe('parseVoipTokenField', () => {
  it('keeps a token, trimmed and bounded to the column', () => {
    expect(parseVoipTokenField('  abc  ')).toBe('abc');
    expect(parseVoipTokenField('a'.repeat(300))).toHaveLength(255);
  });

  it('reads an explicit null as "this binary has no native ring" - clear the column', () => {
    expect(parseVoipTokenField(null)).toBeNull();
  });

  it('leaves the column alone when the device said nothing usable', () => {
    for (const raw of [undefined, '', '   ', 42, {}, false]) {
      expect(parseVoipTokenField(raw)).toBeUndefined();
    }
  });
});

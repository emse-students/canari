import { rgbToHex } from './nativeTabIcons';

/** The plugin's tint parser reads `#RRGGBB[AA]`; a pixel's channels are what we have. */
describe('rgbToHex', () => {
  it('writes two lowercase hex digits per channel', () => {
    expect(rgbToHex(225, 113, 0)).toBe('#e17100');
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
  });
});

import { describe, expect, it } from 'vitest';
import { pickAppFont } from './appFonts';

describe('pickAppFont', () => {
  // `'Leckerli One','Fredoka Variable',cursive` used to match Fredoka, the FALLBACK, and the calendar
  // title was drawn in it over a preview in Leckerli One (2026-09-27).
  it('resolves the stack in order, so a fallback never wins over the face asked for', () => {
    expect(pickAppFont('"Leckerli One", "Fredoka Variable", cursive', 400)).toEqual({
      name: 'LeckerliOne',
      style: 'normal',
    });
    expect(pickAppFont('Chewy, "Fredoka Variable", sans-serif', 400)).toEqual({
      name: 'Chewy',
      style: 'normal',
    });
  });

  it('skips a family it does not embed and takes the next one it does', () => {
    expect(pickAppFont('"Segoe UI", "Nunito Variable", sans-serif', 800)).toEqual({
      name: 'NunitoExtra',
      style: 'normal',
    });
    expect(pickAppFont('"Fredoka Variable", sans-serif', 700)).toEqual({
      name: 'Fredoka',
      style: 'bold',
    });
  });

  it('returns null when no family in the stack is embedded', () => {
    expect(pickAppFont('Georgia, serif', 400)).toBeNull();
  });
});

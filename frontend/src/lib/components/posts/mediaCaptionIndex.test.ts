import { shiftAfterRemoval } from './mediaCaptionIndex';

describe('shiftAfterRemoval', () => {
  it('keeps the open caption on ITS photo when an earlier one is removed', () => {
    expect(shiftAfterRemoval(2, 0)).toBe(1);
  });

  it('leaves it alone when a later photo is removed', () => {
    expect(shiftAfterRemoval(1, 3)).toBe(1);
  });

  it('closes it when its own photo is removed', () => {
    expect(shiftAfterRemoval(1, 1)).toBeNull();
  });

  it('stays closed when nothing was open', () => {
    expect(shiftAfterRemoval(null, 0)).toBeNull();
  });
});

/**
 * Types for `thumbhash` (Evan Wallace, MIT), which ships plain ES modules and no declarations. Only
 * the three functions `mediaPlaceholder.ts` calls are declared; adding a fourth is adding a line.
 */
declare module 'thumbhash' {
  /** Encodes an RGBA image of at most 100x100 pixels into a ThumbHash. */
  export function rgbaToThumbHash(w: number, h: number, rgba: ArrayLike<number>): Uint8Array;
  /** Decodes a ThumbHash into a small PNG data URL. */
  export function thumbHashToDataURL(hash: ArrayLike<number>): string;
  /** The average colour of a ThumbHash, each channel in 0..1. */
  export function thumbHashToAverageRGBA(hash: ArrayLike<number>): {
    r: number;
    g: number;
    b: number;
    a: number;
  };
}

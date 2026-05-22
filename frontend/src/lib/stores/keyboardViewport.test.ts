import { describe, expect, it } from 'vitest';

describe('keyboard viewport math', () => {
  it('computes inset from inner height and visual viewport', () => {
    const winH = 800;
    const vvHeight = 480;
    const offsetTop = 0;
    const insetBottom = Math.max(0, winH - vvHeight - offsetTop);
    expect(insetBottom).toBe(320);
  });

  it('accounts for offsetTop in adjustPan mode', () => {
    const winH = 800;
    const vvHeight = 480;
    const offsetTop = 40;
    const insetBottom = Math.max(0, winH - vvHeight - offsetTop);
    expect(insetBottom).toBe(280);
  });
});

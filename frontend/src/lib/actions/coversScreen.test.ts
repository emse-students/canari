// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { coversScreen, screenCover } from './coversScreen.svelte';

describe('coversScreen - what the iOS native tab bar hides under', () => {
  const node = () => document.createElement('div');

  it('is covered while one surface is mounted, and uncovered once it is destroyed', () => {
    const a = coversScreen(node());
    expect(screenCover.covered).toBe(true);
    a.destroy();
    expect(screenCover.covered).toBe(false);
  });

  it('stays covered until the LAST of two stacked surfaces goes', () => {
    const a = coversScreen(node());
    const b = coversScreen(node());
    a.destroy();
    expect(screenCover.covered).toBe(true);
    b.destroy();
    expect(screenCover.covered).toBe(false);
  });

  it('a surface destroyed twice cannot uncover another one', () => {
    const a = coversScreen(node());
    const b = coversScreen(node());
    a.destroy();
    a.destroy();
    expect(screenCover.covered).toBe(true);
    b.destroy();
  });

  it('follows `active` for a surface that is only sometimes covering', () => {
    const a = coversScreen(node(), false);
    expect(screenCover.covered).toBe(false);
    a.update(true);
    expect(screenCover.covered).toBe(true);
    a.update(false);
    expect(screenCover.covered).toBe(false);
    a.destroy();
  });

  it('marks the surface while it covers, which is what keeps a call bar above it (app.css)', () => {
    const el = node();
    const a = coversScreen(el, false);
    expect(el.hasAttribute('data-covers-screen')).toBe(false);
    a.update(true);
    expect(el.hasAttribute('data-covers-screen')).toBe(true);
    a.destroy();
    expect(el.hasAttribute('data-covers-screen')).toBe(false);
  });
});

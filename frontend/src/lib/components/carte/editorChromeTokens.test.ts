import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The colours of what the carte editor draws OVER the poster (selection, handles, snap lines, the
 * overlap warning) and of the link preview's placeholder come from the tokens of `app.css`. The
 * poster's own white text is the document, not the interface, so it stays a literal.
 */
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf-8');
const hexColours = (text: string) => text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];

describe('colours written in a component', () => {
  it('the carte editor names no colour but the white of the poster itself', () => {
    const colours = hexColours(source('./PosterCanvas.svelte'));

    expect(new Set(colours)).toEqual(new Set(['#ffffff']));
  });

  it('the link preview placeholder names none', () => {
    expect(hexColours(source('../shared/CanariLinkPreviewMedia.svelte'))).toEqual([]);
  });

  it('the gradient stop it uses is a token of app.css', () => {
    expect(source('../../../app.css')).toMatch(/--color-cn-ink-soft:\s*#1e2848;/);
  });
});

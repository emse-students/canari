/**
 * AN EMOJI PICTURE MUST NOT OPEN iOS'S NATIVE IMAGE MENU (user, 2026-10-01, iPhone).
 *
 * A source pin, said honestly: no gate here runs WebKit's long-press callout, so this reads the
 * stylesheet and asserts the one rule that suppresses it covers BOTH ways an emoji picture reaches
 * the DOM - the `.emoji` class (`EmojiText`, `emojiSvg.ts`) and the `/emoji/` source (the picker
 * grid, which classes its own pictures). The result was read on the iPhone, see
 * `docs/wiki/frontend/emoji.md`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '$lib/styles/markupSources';
import { EMOJI_SVG_BASE } from '$lib/utils/emojiSvg';

const css = withoutAnyComments(readFileSync(join(process.cwd(), 'src', 'app.css'), 'utf8'));

describe('the emoji pictures and the native image menu', () => {
  it('turns the callout off for the .emoji class and for every picture served from the emoji set', () => {
    const rule = /([^{}]*)\{[^{}]*-webkit-touch-callout:\s*none[^{}]*\}/.exec(css);
    expect(rule, 'a rule setting -webkit-touch-callout: none').not.toBeNull();
    const selectors = rule![1].split(',').map((s) => s.trim());
    expect(selectors).toContain('img.emoji');
    expect(selectors).toContain(`img[src^='${EMOJI_SVG_BASE.replace(/[^/]+\/$/, '')}']`);
  });
});

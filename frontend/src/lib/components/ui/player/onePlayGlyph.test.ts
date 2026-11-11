/**
 * ONE PLAY GLYPH (owner, 2026-11-11): every overlay that says "this is a video" draws the glass
 * triangle of `VideoGlassGlyph`, never a disc around a Lucide `Play`. The three overlays that once
 * drew their own are checked structurally: a Lucide `Play` import or a `<Play` element in any of
 * them fails here, and each must render the glass glyph.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OVERLAYS = [
  '../../messages/ChatReelTile.svelte',
  '../../posts/ReplayCard.svelte',
  '../../chat/SharedMediaThumb.svelte',
];

describe('one play glyph', () => {
  for (const rel of OVERLAYS) {
    it(`${rel.split('/').pop()} uses the glass glyph and no Lucide Play`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const lucide = src.match(/import\s*\{([^}]*)\}\s*from\s*'@lucide\/svelte'/)?.[1] ?? '';
      expect(lucide.split(',').map((n) => n.trim())).not.toContain('Play');
      expect(src).not.toMatch(/<Play[\s/>]/);
      expect(src).toContain('<VideoGlassGlyph kind="play"');
    });
  }
});

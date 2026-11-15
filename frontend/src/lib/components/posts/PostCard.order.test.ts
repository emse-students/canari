import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE POLL SITS BETWEEN THE CARDS AND THE ACTION BAR (owner, 2026-11-15). `PostContent` draws the
 * text, the media and the card zone; the card then draws the poll, then the action bar, then the
 * comments. The poll used to come after the action bar. Source-pinned: the order is the markup's.
 */
describe('PostCard - the poll closes the card zone', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'PostCard.svelte'),
    'utf8'
  );
  const markup = source.slice(source.indexOf('</script>'));

  it('draws PostContent, then the poll, then the action bar, then the comments', () => {
    // A tag followed by white space: `<PostActions` must not match the header's `<PostActionsMenu`.
    const at = (tag: string) => {
      const i = markup.search(new RegExp(`${tag}\\s`));
      expect(i, `${tag} is drawn`).toBeGreaterThan(-1);
      return i;
    };
    const order = ['<PostContent', '<PostPolls', '<PostActions', '<CommentsPreview'].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('draws no second form list and no event pill of its own', () => {
    expect(markup).not.toContain('<PostForms');
    expect(markup).not.toContain('linkedCalendarEvent');
  });
});

import EmojiText from '../shared/EmojiText.svelte';
import PostCodeBlock from './PostCodeBlock.svelte';
import PostCodespan from './PostCodespan.svelte';
import PostMentionLink from './PostMentionLink.svelte';

/**
 * The renderers every user-written Markdown surface hands `SvelteMarkdown` - a post, a comment, a
 * profile bio. They were three copies of the same object until the emoji pictures needed a fourth
 * key, and three copies is where one of them is left without it.
 *
 * - `link`: a mention link opens the profile; everything else stays a link.
 * - `code` / `codespan`: highlighted blocks and inline code. Emoji inside code stay CHARACTERS -
 *   code is quoted text, and those renderers never reach `rawtext`.
 * - `rawtext`: every leaf of prose, so an emoji in a paragraph, a list item, a heading or a quote is
 *   Noto's picture like it is in a message (`EmojiText`, `docs/wiki/frontend/emoji.md`).
 */
export const POST_MARKDOWN_RENDERERS = {
  link: PostMentionLink,
  code: PostCodeBlock,
  codespan: PostCodespan,
  rawtext: EmojiText,
};

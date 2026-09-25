/**
 * AN EMOJI IN A POST IS NOTO'S PICTURE, AND AN EMOJI IN CODE IS STILL A CHARACTER.
 *
 * `POST_MARKDOWN_RENDERERS.rawtext` is how the pictures reach prose rendered by `SvelteMarkdown`,
 * and the library only honours a `rawtext` override on its inline path because it checks for one
 * (`Parser.svelte`). So this asserts the override is REACHED - by counting pictures in a rendered
 * post - rather than trusting that the key is spelled right. Code is the other half: it is quoted
 * text, rendered by `PostCodespan`, and must not turn into pictures.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SvelteMarkdown from '@humanspeak/svelte-markdown';
import { POST_MARKDOWN_RENDERERS } from './postMarkdownRenderers';

let mounted: Record<string, unknown> | null = null;
afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
});

function renderPost(source: string): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted = mount(SvelteMarkdown, {
    target,
    props: { source, renderers: POST_MARKDOWN_RENDERERS, options: { gfm: true, breaks: true } },
  });
  flushSync();
  return target;
}

describe('POST_MARKDOWN_RENDERERS', () => {
  it('draws emoji in prose, bold text and list items as pictures', () => {
    const post = renderPost('Salut 😀 **gras 🎉**\n\n- une liste 🇫🇷');
    const pictures = [...post.querySelectorAll('img.emoji')].map((img) => img.getAttribute('alt'));
    expect(pictures).toEqual(['😀', '🎉', '🇫🇷']);
    expect(post.textContent).toContain('Salut');
  });

  it('keeps emoji inside code as characters', () => {
    const post = renderPost('voir `code 😀`');
    expect(post.querySelector('code')?.textContent).toContain('😀');
    expect(post.querySelector('code img.emoji')).toBeNull();
  });
});

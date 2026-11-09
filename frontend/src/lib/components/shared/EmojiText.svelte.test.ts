// @vitest-environment happy-dom
/**
 * `EmojiText` IN BOTH EMOJI MODES (owner, 2026-11-09). "system", the default, prints the text as
 * text - no `<img>`, so no picture is fetched - and "Canari" prints today's pictures. An artefact
 * override (`emojiStyle="canari"`, the PDF poster) keeps the pictures whatever the user chose.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import EmojiText from './EmojiText.svelte';
import { setEmojiStyle } from '$lib/utils/emojiStyle';

let component: ReturnType<typeof mount> | null = null;

function render(props: { text: string; emojiStyle?: 'system' | 'canari' }) {
  component = mount(EmojiText, { target: document.body, props });
  flushSync();
}

const pictures = () =>
  [...document.body.querySelectorAll<HTMLImageElement>('img.emoji')].map((img) => img.alt);

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  setEmojiStyle('system');
  localStorage.removeItem('canari_emoji_style');
});

describe('EmojiText', () => {
  it('draws no picture by default: the platform font draws the emoji, tones included', () => {
    render({ text: 'salut 😀 et 👍🏽' });
    expect(pictures()).toEqual([]);
    expect(document.body.textContent).toBe('salut 😀 et 👍🏽');
  });

  it('draws the pictures under "Canari", exactly as before the setting', () => {
    setEmojiStyle('canari');
    render({ text: 'salut 😀 et 👍🏽' });
    expect(pictures()).toEqual(['😀', '👍🏽']);
    const img = document.body.querySelector<HTMLImageElement>('img.emoji')!;
    expect(img.getAttribute('src')).toMatch(/^\/emoji\/[0-9a-f]+\/1f600\.svg$/);
  });

  it('follows a change of the setting without a remount', () => {
    render({ text: 'a 😀' });
    expect(pictures()).toEqual([]);
    setEmojiStyle('canari');
    flushSync();
    expect(pictures()).toEqual(['😀']);
    setEmojiStyle('system');
    flushSync();
    expect(pictures()).toEqual([]);
  });

  it('keeps the pictures for an artefact whatever the user chose', () => {
    render({ text: 'a 😀', emojiStyle: 'canari' });
    expect(pictures()).toEqual(['😀']);
  });
});

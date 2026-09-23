/**
 * A PHOTO'S CAPTION SHOWED THE WIRE TOKEN OF A MENTION, AND NOTHING WAS EVER GOING TO FIX IT.
 *
 * `MessageBubble` renders `MessageTextBody` only `{#if !mediaRef}`; a message that carries an
 * attachment hands its caption to `MessageMediaRenderer`, which printed each text segment verbatim.
 * So `Dans le retro @[7283faf1...]` reached the screen as those 64 hex characters - reported by the
 * user on 2026-09-23 with the detail that settles the diagnosis: *"le refresh ou le relancement de
 * l'app ne fait rien"*. A cold display-name cache clears on its own the moment a name arrives; this
 * never did, because no resolver was on the path at all.
 *
 * THE ASSERTION IS ON THE CAPTION, NOT ON THE PARSER. `splitTextWithMentions` was correct
 * throughout and its own tests passed the whole time - what was missing was a caller. A test of the
 * parser would have gone on passing through the entire life of this defect.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageMediaRenderer from './MessageMediaRenderer.svelte';
import { seedUserDisplayName } from '$lib/utils/users/displayName';
import type { MediaRef } from '$lib/media';

/** The id from the user's report, which is the shape the composer writes: 64 lowercase hex. */
const MENTIONED_ID = '7283faf13e493ccffa97085f853a0d00967006e814a28254e0560c9cf282799a';
const MENTIONED_NAME = 'Mathéo BOUDIER';

const image: MediaRef = {
  type: 'image',
  mediaId: 'media-1',
  key: '00'.repeat(32),
  iv: '00'.repeat(12),
  mimeType: 'image/png',
  size: 1024,
};

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/** Mounts the renderer the way `MessageBubble` does for a picture carrying a caption. */
function renderCaption(text: string): void {
  const instance = mount(MessageMediaRenderer, {
    target: document.body,
    props: {
      mediaRef: image,
      blobUrl: null,
      loadError: false,
      mediaPurgedByRetention: false,
      textContent: text,
      textSegments: [{ type: 'text' as const, value: text }],
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

describe('MessageMediaRenderer - the caption resolves what a message body resolves', () => {
  it('renders a mention as the name, and never as the token', () => {
    // Seeded rather than fetched: the chip reads the cache synchronously, and what is under test
    // is whether it is asked at all - not how a profile lookup behaves.
    seedUserDisplayName(MENTIONED_ID, MENTIONED_NAME);
    renderCaption(`Dans le rétro @[${MENTIONED_ID}]`);

    const rendered = document.body.textContent ?? '';
    expect(rendered, 'the wire token must not reach the screen').not.toContain(MENTIONED_ID);
    expect(rendered, 'the caption names the person').toContain(`@${MENTIONED_NAME}`);
  });

  it('renders a hashtag with the bubble weight rather than as bare text', () => {
    renderCaption('Soirée #retro');

    const tag = document.querySelector('span.font-semibold');
    expect(tag?.textContent, 'the hashtag is styled by the shared renderer').toBe('#retro');
  });

  it('leaves a caption with neither one exactly as it was written', () => {
    renderCaption('Juste une photo');
    expect(document.body.textContent).toContain('Juste une photo');
  });
});

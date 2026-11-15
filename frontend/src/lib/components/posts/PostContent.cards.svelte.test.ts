// @vitest-environment happy-dom
/**
 * TEXT, MEDIA, CARDS - ONE FIXED ORDER, AND A FORM DRAWN ONCE (owner, 2026-11-15). The post of the
 * before shots: a text with an external link and a link to the attached form, a photo, a PDF, the
 * attached form and a linked event. Before, the event sat ABOVE the text, the links between the text
 * and the photo, and the attached form after the action bar, AS WELL AS its link card. The media
 * layer and the link card are stand-ins that say what they were handed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { publicAppOrigin } from '$lib/utils/publicAppUrl';

vi.mock('./PostMedia.svelte', async () => ({
  default: (await import('./PostMediaOpenStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/MediaLightbox.svelte', async () => ({
  default: (await import('./MediaLightboxStub.test-helper.svelte')).default,
}));
vi.mock('../messages/LinkPreviewCard.svelte', async () => ({
  default: (await import('./LinkPreviewStub.test-helper.svelte')).default,
}));
vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkFormReminder: async () => ({ subscribed: false }),
}));

import PostContent from './PostContent.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const doc = (n: number) => ({
  type: 'file',
  mediaId: `f-${n}`,
  key: 'k',
  iv: 'i',
  mimeType: 'application/pdf',
  size: 1,
  fileName: `doc-${n}.pdf`,
});
const image = (n: number) => ({
  type: 'image',
  mediaId: `i-${n}`,
  key: 'k',
  iv: 'i',
  mimeType: 'image/jpeg',
  size: 1,
  width: 100,
  height: 100,
});
const WIKI = 'https://fr.wikipedia.org/wiki/Mines';
const FORM = `${publicAppOrigin()}/forms/f1`;
const event = {
  id: 'e1',
  title: 'Soiree',
  startsAt: '2026-11-20T20:00:00Z',
  endsAt: null,
  associationSlug: 'bde',
};

function render(post: Record<string, unknown>, forms?: string[]) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const attachedForms = forms
    ? {
        ids: forms,
        infos: forms.map((id) => ({ id, title: `Form ${id}`, submitted: false, opensAt: null })),
      }
    : undefined;
  const app = mount(PostContent, {
    target,
    props: {
      post: { id: 'p1', createdAt: new Date(0).toISOString(), ...post } as never,
      authToken: 'tok',
      attachedForms,
    },
  });
  mounted.push(() => unmount(app));
  flushSync();
  return target;
}

/** What the post draws, top to bottom: the text, then each card of the zone by kind. */
function sequence(target: HTMLElement): string[] {
  const nodes = target.querySelectorAll<HTMLElement>('.post-markdown, [data-post-cards] > *');
  return [...nodes].map((node) => {
    if (node.classList.contains('post-markdown')) return 'text';
    const kinds = '[data-attachment-card], [data-link-stub], [data-post-media-open]';
    const card = node.matches(kinds) ? node : node.querySelector<HTMLElement>(kinds);
    if (!card) return 'unknown';
    if (card.dataset.attachmentCard) return card.dataset.attachmentCard;
    if (card.hasAttribute('data-link-stub')) return 'link';
    return 'file';
  });
}

describe('PostContent - the fixed order and the one form', () => {
  it('draws text, then the photo, then event, form, file and link - the form once', () => {
    const target = render(
      {
        markdown: `Infos sur ${WIKI} et inscription ici ${FORM}`,
        media: [image(1), doc(1)],
        linkedCalendarEvent: event,
      },
      ['f1']
    );
    const zone = target.querySelector('[data-post-cards]')!;
    // The photo is before the zone, the text before the photo.
    const text = target.querySelector('.post-markdown')!;
    const photo = target.querySelector('[data-post-media-open][data-media-id="i-1"]')!;
    expect(text.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(photo.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sequence(target)).toEqual(['text', 'event', 'form', 'file', 'link']);
    // The link to the attached form is not a second card...
    const links = [...zone.querySelectorAll<HTMLElement>('[data-link-stub]')].map(
      (l) => l.dataset.url
    );
    expect(links).toEqual([WIKI]);
    // ...and leaves the text, where the mid-sentence link stays.
    expect(text.textContent).toContain('inscription ici');
    expect(text.textContent).not.toContain('/forms/f1');
    expect(text.textContent).toContain('wikipedia');
  });

  it('keeps a form link of its own in the moderation preview, which reads no forms', () => {
    const target = render({ markdown: `Inscription ici ${FORM}` });
    const links = [...target.querySelectorAll<HTMLElement>('[data-link-stub]')].map(
      (l) => l.dataset.url
    );
    expect(links).toEqual([FORM]);
    expect(target.querySelector('[data-attachment-card="form"]')).toBeNull();
  });
});

describe('PostContent - files are cards, the lone one a hero', () => {
  const flags = (target: HTMLElement) =>
    [...target.querySelectorAll<HTMLElement>('[data-post-cards] [data-post-media-open]')].map(
      (slot) => slot.dataset.compact
    );

  it('draws a lone document with little text large (not compact)', () => {
    expect(flags(render({ markdown: 'Le reglement', media: [doc(1)] }))).toEqual(['false']);
  });

  it('draws a document beside pictures, or two documents, as compact rows', () => {
    expect(flags(render({ markdown: '', media: [image(1), doc(1)] }))).toEqual(['true']);
    expect(flags(render({ markdown: '', media: [doc(1), doc(2)] }))).toEqual(['true', 'true']);
  });

  it('draws a lone link large and the lone event as a hero card', () => {
    const link = render({ markdown: WIKI });
    expect(link.querySelector<HTMLElement>('[data-link-stub]')!.dataset.hero).toBe('true');
    expect(link.querySelector('.post-markdown')).toBeNull();
    const ev = render({ markdown: 'Ce soir', linkedCalendarEvent: event });
    expect(ev.querySelector('[data-attachment-card="event"]')?.hasAttribute('data-hero')).toBe(
      true
    );
  });
});

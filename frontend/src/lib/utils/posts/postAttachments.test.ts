import { describe, expect, it } from 'vitest';
import type { PostMediaRef } from '$lib/posts/api';
import { HERO_TEXT_MAX, planPostAttachments, stripCardedUrls } from './postAttachments';
import { publicAppOrigin } from '$lib/utils/publicAppUrl';

const media = (id: string, mimeType: string, type?: string): PostMediaRef =>
  ({ mediaId: id, key: 'k', iv: 'i', mimeType, ...(type ? { type } : {}) }) as PostMediaRef;
const photo = media('p1', 'image/jpeg', 'image');
const pdf = media('d1', 'application/pdf', 'file');
const event = {
  id: 'e1',
  title: 'Soiree',
  startsAt: '2026-11-20T20:00:00Z',
  endsAt: null,
  associationSlug: 'bde',
};
const formUrl = (id: string) => `${publicAppOrigin()}/forms/${id}`;
const WIKI = 'https://fr.wikipedia.org/wiki/Mines';

describe('planPostAttachments - the fixed order', () => {
  it('draws text, media, then event, forms, files and links, whatever the text says first', () => {
    const plan = planPostAttachments(
      {
        markdown: `Voir ${WIKI} pour tout savoir.\nInscription ici ${formUrl('other')}`,
        media: [pdf, photo],
        linkedCalendarEvent: event,
      },
      ['f1']
    );
    expect(plan.media).toEqual([photo]);
    expect(plan.cards.map((c) => c.kind)).toEqual(['event', 'form', 'file', 'link', 'link']);
    expect(plan.cards[3]).toEqual({ kind: 'link', url: WIKI });
    expect(plan.cards[4]).toEqual({ kind: 'link', url: formUrl('other') });
    expect(plan.hero).toBe(false);
  });

  it('draws an attached form ONCE when the text also links to it', () => {
    const plan = planPostAttachments({ markdown: `Inscriptions ici ${formUrl('f1')}`, media: [] }, [
      'f1',
    ]);
    expect(plan.cards).toEqual([{ kind: 'form', formId: 'f1' }]);
    // The link the attached card stands for leaves the text too.
    expect(plan.markdown).toBe('Inscriptions ici');
  });

  it('keeps a form link of its own when that form is not attached', () => {
    const plan = planPostAttachments({ markdown: formUrl('f2') }, ['f1']);
    expect(plan.cards).toEqual([
      { kind: 'form', formId: 'f1' },
      { kind: 'link', url: formUrl('f2') },
    ]);
  });
});

describe('stripCardedUrls', () => {
  it('takes a carded URL off the end of its line, keeps it mid-sentence', () => {
    expect(
      stripCardedUrls(`plus d'infos sur ${WIKI} et ici ${formUrl('x')}`, [WIKI, formUrl('x')])
    ).toBe(`plus d'infos sur ${WIKI} et ici`);
  });

  it('drops a line holding only the URL, and keeps trailing punctuation', () => {
    expect(stripCardedUrls(`Bonjour\n${WIKI}\nVoir ${WIKI}.`, [WIKI])).toBe('Bonjour\nVoir.');
  });

  it('never touches a labelled link, an autolink or a code block', () => {
    const text = `[la page](${WIKI})\n<${WIKI}>\n\`\`\`\n${WIKI}\n\`\`\``;
    expect(stripCardedUrls(text, [WIKI])).toBe(text);
  });

  it('leaves a URL with no card alone', () => {
    expect(stripCardedUrls(`Voir ${WIKI}`, [])).toBe(`Voir ${WIKI}`);
  });
});

describe('planPostAttachments - the hero', () => {
  it('puts a lone link, PDF, form or event forward under a short caption', () => {
    expect(planPostAttachments({ markdown: `A lire ${WIKI}` }, []).hero).toBe(true);
    expect(planPostAttachments({ markdown: '', media: [pdf] }, []).hero).toBe(true);
    expect(planPostAttachments({ markdown: 'Inscrivez-vous' }, ['f1']).hero).toBe(true);
    expect(planPostAttachments({ markdown: 'Ce soir', linkedCalendarEvent: event }, []).hero).toBe(
      true
    );
  });

  it('counts the plain text, without the URL the card replaces', () => {
    const caption = 'x'.repeat(HERO_TEXT_MAX);
    expect(planPostAttachments({ markdown: `${caption} ${WIKI}` }, []).hero).toBe(true);
    expect(planPostAttachments({ markdown: `${caption}y ${WIKI}` }, []).hero).toBe(false);
    expect(planPostAttachments({ markdown: `**${caption}**` }, ['f1']).hero).toBe(true);
  });

  it('is off with a second card, a picture, a poll or a replay', () => {
    expect(planPostAttachments({ markdown: '', media: [pdf] }, ['f1']).hero).toBe(false);
    expect(planPostAttachments({ markdown: WIKI, media: [photo] }, []).hero).toBe(false);
    const polls = [{ id: 'p' }] as never;
    expect(planPostAttachments({ markdown: WIKI, polls }, []).hero).toBe(false);
    expect(planPostAttachments({ markdown: WIKI }, [], true).hero).toBe(false);
  });

  it('is off with no card at all (a lone picture is already drawn large)', () => {
    expect(planPostAttachments({ markdown: '', media: [photo] }, []).hero).toBe(false);
  });
});

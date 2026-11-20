import { describe, expect, it } from 'vitest';
import type { MediaRef } from '$lib/media';
import { setLocale } from '$lib/paraglide/runtime';
import { quoteReference } from '$lib/utils/chat/messaging';
import type { ChatMessage } from '$lib/types';
import { getPreviewText, mediaKindLabel, mkMediaEnvelope, previewForMedia } from './envelope';

/**
 * A media message is previewed by WHAT IT IS, never as "[Media]" (owner, 2026-11-20). ONE
 * classification feeds the list, the quotes, the notification body and the share sheet.
 */
const ref = (over: Partial<MediaRef>): MediaRef => ({
  type: 'image',
  mediaId: 'm1',
  key: '',
  iv: '',
  mimeType: 'image/jpeg',
  size: 1,
  ...over,
});

describe('mediaKindLabel', () => {
  it.each([
    ['a photo', { type: 'image' as const }, '📷 Photo'],
    ['a GIF', { type: 'image' as const, mimeType: 'image/gif' }, '🌀 GIF'],
    ['a video', { type: 'video' as const, mimeType: 'video/mp4' }, '🎥 Vidéo'],
    ['a CanaReel', { type: 'video' as const, intent: 'reel-message' as const }, '🎬 CanaReel'],
    ['a recorded voice note', { type: 'audio' as const, voiceNote: true }, '🎤 Message vocal'],
    ['an imported audio file', { type: 'audio' as const }, '🎵 Fichier audio'],
    ['a named file', { type: 'file' as const, fileName: 'cours.pdf' }, '📎 Fichier : cours.pdf'],
    ['a nameless file', { type: 'file' as const }, '📎 Pièce jointe'],
  ])('words %s', (_what, over, expected) => {
    expect(mediaKindLabel(ref(over))).toBe(expected);
  });

  it('reads a GIF mime type whatever its case', () => {
    expect(mediaKindLabel(ref({ mimeType: 'IMAGE/GIF' }))).toBe('🌀 GIF');
  });

  it('strips control, bidi and invisible characters from a file name', () => {
    const name = 'a‮cod.exe\u0000​b\nc.pdf';
    expect(mediaKindLabel(ref({ type: 'file', fileName: name }))).toBe(
      '📎 Fichier : acod.exeb c.pdf'
    );
  });

  it('caps a long file name, and a name of only invisible characters reads nameless', () => {
    const label = mediaKindLabel(ref({ type: 'file', fileName: 'x'.repeat(500) }));
    expect(label).toBe(`📎 Fichier : ${'x'.repeat(59)}…`);
    expect(mediaKindLabel(ref({ type: 'file', fileName: '​‮ ' }))).toBe('📎 Pièce jointe');
  });

  it('speaks English when the reader does', () => {
    setLocale('en');
    expect(mediaKindLabel(ref({ type: 'video' }))).toBe('🎥 Video');
    expect(mediaKindLabel(ref({ type: 'file', fileName: 'a.pdf' }))).toBe('📎 File: a.pdf');
    expect(previewForMedia(ref({}), 'hi')).toBe('📷 Photo: hi');
  });
});

describe('previewForMedia', () => {
  it('appends the caption after the kind', () => {
    expect(previewForMedia(ref({}), 'coucou')).toBe('📷 Photo : coucou');
  });

  it('drops the file name when a caption follows, to stay short', () => {
    expect(previewForMedia(ref({ type: 'file', fileName: 'cours.pdf' }), 'le TD')).toBe(
      '📎 Pièce jointe : le TD'
    );
  });

  it('reads an empty caption as none', () => {
    expect(previewForMedia(ref({}), '')).toBe('📷 Photo');
  });

  it('is what getPreviewText gives a media envelope', () => {
    expect(getPreviewText(mkMediaEnvelope(ref({ type: 'video' }), 'x'))).toBe('🎥 Vidéo : x');
  });
});

describe('quoteReference of a media message', () => {
  const quoted = (media: MediaRef, caption?: string): ChatMessage =>
    ({
      id: 'q1',
      senderId: 'bob',
      content: JSON.stringify(mkMediaEnvelope(media, caption)),
    }) as unknown as ChatMessage;

  it('names the kind when there is no caption', () => {
    expect(quoteReference(quoted(ref({ type: 'video' }))).content).toBe('🎥 Vidéo');
  });

  it('keeps the kind with the caption, the caption raw', () => {
    expect(quoteReference(quoted(ref({}), 'le @[u1] TD')).content).toBe('📷 Photo : le @[u1] TD');
  });

  it('never stores an uncapped line for a long name', () => {
    const content = quoteReference(
      quoted(ref({ type: 'file', fileName: 'y'.repeat(900) }))
    ).content;
    expect(content.length).toBeLessThanOrEqual(100);
    expect(content.startsWith('📎 Fichier : yyy')).toBe(true);
  });
});

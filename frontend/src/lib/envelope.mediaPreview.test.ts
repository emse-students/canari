import { describe, expect, it } from 'vitest';
import type { MediaRef } from '$lib/media';
import { setLocale } from '$lib/paraglide/runtime';
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
    ['a photo', { type: 'image' as const }, 'Photo'],
    ['a GIF', { type: 'image' as const, mimeType: 'image/gif' }, '[GIF]'],
    ['a video', { type: 'video' as const, mimeType: 'video/mp4' }, 'Vidéo'],
    ['a CanaReel', { type: 'video' as const, intent: 'reel-message' as const }, 'CanaReel'],
    ['a recorded voice note', { type: 'audio' as const, voiceNote: true }, 'Message vocal'],
    ['an imported audio file', { type: 'audio' as const }, 'Fichier audio'],
    ['a named file', { type: 'file' as const, fileName: 'cours.pdf' }, 'Fichier : cours.pdf'],
    ['a nameless file', { type: 'file' as const }, 'Pièce jointe'],
  ])('words %s', (_what, over, expected) => {
    expect(mediaKindLabel(ref(over))).toBe(expected);
  });

  it('speaks English when the reader does', () => {
    setLocale('en');
    expect(mediaKindLabel(ref({ type: 'video' }))).toBe('Video');
    expect(mediaKindLabel(ref({ type: 'file', fileName: 'a.pdf' }))).toBe('File: a.pdf');
    expect(previewForMedia(ref({}), 'hi')).toBe('Photo: hi');
  });
});

describe('previewForMedia', () => {
  it('appends the caption after the kind', () => {
    expect(previewForMedia(ref({}), 'coucou')).toBe('Photo : coucou');
  });

  it('drops the file name when a caption follows, to stay short', () => {
    expect(previewForMedia(ref({ type: 'file', fileName: 'cours.pdf' }), 'le TD')).toBe(
      'Pièce jointe : le TD'
    );
  });

  it('reads an empty caption as none', () => {
    expect(previewForMedia(ref({}), '')).toBe('Photo');
  });

  it('is what getPreviewText gives a media envelope', () => {
    expect(getPreviewText(mkMediaEnvelope(ref({ type: 'video' }), 'x'))).toBe('Vidéo : x');
  });
});

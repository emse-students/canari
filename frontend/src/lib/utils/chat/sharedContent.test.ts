import { aggregateSharedContent, type AggregatableMessage } from './sharedContent';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

function mediaRef(type: MediaRef['type'], id: string): MediaRef {
  return { type, mediaId: id, key: 'aa', iv: 'bb', mimeType: 'application/octet-stream', size: 1 };
}

function msg(
  id: string,
  timestamp: number,
  content: string,
  isDeleted = false
): AggregatableMessage {
  return { id, senderId: 'u1', timestamp, content, isDeleted };
}

describe('aggregateSharedContent', () => {
  it('splits images/videos into media and audio/files into files', () => {
    const messages = [
      msg('m1', 1, serializeEnvelope(mkMediaEnvelope(mediaRef('image', 'img1')))),
      msg('m2', 2, serializeEnvelope(mkMediaEnvelope(mediaRef('video', 'vid1')))),
      msg('m3', 3, serializeEnvelope(mkMediaEnvelope(mediaRef('file', 'doc1')))),
      msg('m4', 4, serializeEnvelope(mkMediaEnvelope(mediaRef('audio', 'aud1')))),
    ];
    const { media, files } = aggregateSharedContent(messages);
    expect(media.map((m) => m.media.mediaId)).toEqual(['vid1', 'img1']); // newest first
    expect(files.map((f) => f.media.mediaId)).toEqual(['aud1', 'doc1']);
  });

  it('extracts links from text messages and media captions, newest first', () => {
    const messages = [
      msg(
        'm1',
        1,
        serializeEnvelope(mkTextEnvelope('voir https://emse.fr/page et https://x.com.'))
      ),
      msg(
        'm2',
        2,
        serializeEnvelope(mkMediaEnvelope(mediaRef('image', 'i'), 'photo http://imgur.com/a'))
      ),
      msg('m3', 3, serializeEnvelope(mkTextEnvelope('aucun lien ici'))),
    ];
    const { links } = aggregateSharedContent(messages);
    expect(links.map((l) => l.url)).toEqual([
      'http://imgur.com/a', // newest
      'https://emse.fr/page',
      'https://x.com', // trailing dot trimmed
    ]);
  });

  /*
   * THE WHOLE POINT OF THE FLAG IS THAT THESE TWO MESSAGES ARE OTHERWISE IDENTICAL. Same envelope
   * kind, same media type, same mime type, same size - so a test that gave them different bytes
   * would pass against a predicate that read the bytes, which is the fallback this change exists to
   * avoid. The only difference between them is what the sender declared.
   */
  it('drops a recorded voice note from the panel and keeps an imported audio file', () => {
    const recorded = { ...mediaRef('audio', 'vocal1'), voiceNote: true };
    const imported = mediaRef('audio', 'chanson1');
    const messages = [
      msg('m1', 1, serializeEnvelope(mkMediaEnvelope(recorded))),
      msg('m2', 2, serializeEnvelope(mkMediaEnvelope(imported))),
    ];
    const { media, files } = aggregateSharedContent(messages);
    expect(files.map((f) => f.media.mediaId)).toEqual(['chanson1']);
    expect(media).toHaveLength(0);
  });

  /**
   * THE MESSAGES THAT PREDATE THE FLAG, and there are two kinds of them - the distinction the user
   * saw on 2026-09-18, months of voice notes filed under `Fichiers` as `vocal_<epoch>.m4a`.
   *
   * Absent is still not "imported": it is unknown, and the name is the ONLY evidence such a message
   * carries. See `isVoiceNote` for why reading it there is bounded rather than a fallback.
   */
  it('drops a voice note recorded before the flag existed, recognised by the name its recorder wrote', () => {
    const legacy = { ...mediaRef('audio', 'vieux-vocal'), fileName: 'vocal_1757900000000.m4a' };
    const messages = [msg('m1', 1, serializeEnvelope(mkMediaEnvelope(legacy)))];
    const { media, files } = aggregateSharedContent(messages);
    expect(files).toHaveLength(0);
    expect(media).toHaveLength(0);
  });

  it('keeps an audio message that predates the flag and carries no recorder name', () => {
    const messages = [msg('m1', 1, serializeEnvelope(mkMediaEnvelope(mediaRef('audio', 'vieux'))))];
    expect(aggregateSharedContent(messages).files.map((f) => f.media.mediaId)).toEqual(['vieux']);
  });

  /**
   * THE ENVELOPE CARRIES `true | undefined` AND NEVER `false` (`envelope.ts:238`), so there is no
   * "declared an import" state to assert at this level - an import is always undeclared, and the
   * name is what separates it. `voiceNote.test.ts` pins the precedence itself.
   */
  it('keeps an imported file, which is undeclared like every other one, under its own name', () => {
    const named = { ...mediaRef('audio', 'chanson2'), fileName: 'balade-a-velo.m4a' };
    const messages = [msg('m1', 1, serializeEnvelope(mkMediaEnvelope(named)))];
    expect(aggregateSharedContent(messages).files.map((f) => f.media.mediaId)).toEqual([
      'chanson2',
    ]);
  });

  it('skips deleted messages', () => {
    const messages = [
      msg('m1', 1, serializeEnvelope(mkMediaEnvelope(mediaRef('image', 'x'))), true),
    ];
    const { media } = aggregateSharedContent(messages);
    expect(media).toHaveLength(0);
  });
});

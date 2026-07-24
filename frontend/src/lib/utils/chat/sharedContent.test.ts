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

  it('skips deleted messages', () => {
    const messages = [
      msg('m1', 1, serializeEnvelope(mkMediaEnvelope(mediaRef('image', 'x'))), true),
    ];
    const { media } = aggregateSharedContent(messages);
    expect(media).toHaveLength(0);
  });
});

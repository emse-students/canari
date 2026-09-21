import { describe, expect, it } from 'vitest';
import {
  applyEditToBody,
  envelopeBodyText,
  mkMediaEnvelope,
  mkTextEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from './envelope';

/**
 * AN EDIT REPLACES A TEXT, NOT A BODY.
 *
 * The reply reference lives inside the envelope stored in `content` and nowhere else - the at-rest
 * payload (`toMessagePayload`) has no `replyTo` key, and `mapStoredMessagesToChatMessages` never
 * rebuilds one. So an applier that wrote the replacement text straight into `content` deleted the
 * quote from the row, and every device that re-read that row showed the message bare. Reported
 * 2026-09-21 as one message quoted on its author's PC and bare on the peer's.
 */
describe('applyEditToBody', () => {
  const quote = { id: 'm0', senderId: 'leon', content: 'je veux bien yes' };

  it('KEEPS the reply reference an edit does not carry - the defect', () => {
    const before = serializeEnvelope(mkTextEnvelope('Doen', quote));

    const after = parseEnvelope(applyEditToBody(before, 'Done'));

    expect(after.kind).toBe('text');
    expect(after.kind === 'text' && after.text).toBe('Done');
    expect(after.kind === 'text' && after.replyTo).toEqual(quote);
  });

  it('edits a message that quotes nothing without inventing anything', () => {
    const after = parseEnvelope(applyEditToBody(serializeEnvelope(mkTextEnvelope('a')), 'b'));

    expect(after.kind === 'text' && after.text).toBe('b');
    expect(after.kind === 'text' && after.replyTo).toBeUndefined();
  });

  it('keeps a legacy plain-text row readable, as an envelope', () => {
    const after = parseEnvelope(applyEditToBody('written before envelopes existed', 'now'));

    expect(after.kind === 'text' && after.text).toBe('now');
  });

  it('edits a media caption instead of throwing the attachment away', () => {
    const media = {
      type: 'image' as const,
      mediaId: 'md1',
      key: 'ab',
      iv: 'cd',
      mimeType: 'image/png',
      size: 12,
    };
    const before = serializeEnvelope(mkMediaEnvelope(media, 'old caption', quote));

    const after = parseEnvelope(applyEditToBody(before, 'new caption'));

    expect(after.kind).toBe('media');
    expect(after.kind === 'media' && after.caption).toBe('new caption');
    expect(after.kind === 'media' && after.media.mediaId).toBe('md1');
    expect(after.kind === 'media' && after.replyTo).toEqual(quote);
  });

  it('is idempotent, which is what a replayed log asks of it', () => {
    const before = serializeEnvelope(mkTextEnvelope('first', quote));

    expect(applyEditToBody(applyEditToBody(before, 'Done'), 'Done')).toBe(
      applyEditToBody(before, 'Done')
    );
  });
});

describe('envelopeBodyText', () => {
  it('reads the replacement body out of every shape a row can hold', () => {
    expect(envelopeBodyText(serializeEnvelope(mkTextEnvelope('hello')))).toBe('hello');
    expect(envelopeBodyText('legacy plain text')).toBe('legacy plain text');
    expect(
      envelopeBodyText(
        serializeEnvelope(
          mkMediaEnvelope(
            { type: 'file', mediaId: 'm', key: 'a', iv: 'b', mimeType: '', size: 0 },
            'caption'
          )
        )
      )
    ).toBe('caption');
  });
});

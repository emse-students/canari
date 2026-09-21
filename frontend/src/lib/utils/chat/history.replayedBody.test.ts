import { describe, expect, it } from 'vitest';
import { replayedRowBody } from './history';
import { chat_system_message_deleted } from '$lib/paraglide/messages';
import { mkTextEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';

/**
 * Which of two claims on one body a replay writes - the archive's frame, or the row this device
 * already holds. The split is the point: an edit's TEXT is ours, its BODY is the archive's.
 */
describe('replayedRowBody', () => {
  const quote = { id: 'm0', senderId: 'leon', content: 'je veux bien yes' };
  const original = serializeEnvelope(mkTextEnvelope('Doen', quote));

  it('takes the decrypted frame when the row claims nothing', () => {
    expect(replayedRowBody(undefined, { content: original })).toBe(original);
    expect(replayedRowBody({ content: 'stale' }, { content: original })).toBe(original);
  });

  it('keeps a tombstone from EITHER source - a delete is final', () => {
    expect(replayedRowBody({ content: 'x', isDeleted: true }, { content: original })).toBe(
      chat_system_message_deleted()
    );
    expect(replayedRowBody(undefined, { content: original, isDeleted: true })).toBe(
      chat_system_message_deleted()
    );
  });

  it('keeps the held EDIT TEXT and takes the BODY from the archive', () => {
    const held = serializeEnvelope(mkTextEnvelope('Done', quote));

    const body = parseEnvelope(
      replayedRowBody({ content: held, isEdited: true }, { content: original })
    );

    expect(body.kind === 'text' && body.text).toBe('Done');
    expect(body.kind === 'text' && body.replyTo).toEqual(quote);
  });

  it('REPAIRS a row edited before the body rule existed, which is the only chance it gets', () => {
    // What such a row holds: the bare replacement text, its reply reference already gone.
    const damaged = { content: 'Done', isEdited: true };

    const body = parseEnvelope(replayedRowBody(damaged, { content: original }));

    expect(body.kind === 'text' && body.text).toBe('Done');
    expect(body.kind === 'text' && body.replyTo).toEqual(quote);
  });
});

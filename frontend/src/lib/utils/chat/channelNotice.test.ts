import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => NAMES[id] ?? id),
}));

import { decodeAppMessage, encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { parseEnvelope } from '$lib/envelope';
import {
  CHANNEL_NOTICE_IDS_WRITER_ENABLED,
  channelMemberAddedData,
  channelNoticePayload,
  channelSystemEnvelope,
} from './channelNotice';

const NAMES: Record<string, string> = { ana: 'Ana', bob: 'Bob' };

function frame(event: string, data: string) {
  return decodeAppMessage(encodeAppMessage({ ...mkSystem(event, data), messageId: 'n1' }))!;
}

describe('channelNoticePayload', () => {
  it('reads an id object and leaves a sentence alone', () => {
    expect(channelNoticePayload('{"newUsers":["ana"]}')).toEqual({ newUsers: ['ana'] });
    expect(channelNoticePayload('Ana a ajoute Bob')).toBeNull();
    expect(channelNoticePayload('[1]')).toBeNull();
    expect(channelNoticePayload('{broken')).toBeNull();
  });
});

describe('channelSystemEnvelope', () => {
  it('draws an id-shaped memberAdded with the names resolved at read time', async () => {
    const env = await channelSystemEnvelope(
      frame('memberAdded', JSON.stringify({ newUsers: ['bob'] })),
      undefined,
      'ana'
    );
    const parsed = parseEnvelope(env!.content);
    expect(parsed).toMatchObject({
      kind: 'system',
      notice: { event: 'memberAdded', actor: 'ana', targets: ['bob'] },
    });
    expect(env!.options.messageId).toBe('n1');
  });

  it('still reads a legacy sentence frame as that sentence', async () => {
    const env = await channelSystemEnvelope(
      frame('memberAdded', 'Ana a ajoute Bob'),
      undefined,
      'ana'
    );
    expect(parseEnvelope(env!.content)).toMatchObject({ kind: 'system', text: 'Ana a ajoute Bob' });
  });

  it('draws nothing, with one line, for ids that name nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = await channelSystemEnvelope(
      frame('memberAdded', JSON.stringify({ newUsers: [] })),
      undefined,
      'ana'
    );
    expect(env).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('channelMemberAddedData - what a salon invitation sends', () => {
  // A build at the floor (1.6.6) draws `system.data` as the sentence it always was, so an id object
  // would reach its screen as raw JSON text. The writer waits for the floor (legacy-compatibility).
  it('ships OFF: no supported build below the reader may receive the id shape', () => {
    expect(CHANNEL_NOTICE_IDS_WRITER_ENABLED).toBe(false);
  });

  it('sends the sentence while the writer is off, which every build reads', async () => {
    const data = await channelMemberAddedData('bob', 'ana', false);
    expect(channelNoticePayload(data)).toBeNull();
    expect(data).toContain('Ana');
    expect(data).toContain('Bob');
  });

  it('sends ids only once the writer is on', async () => {
    expect(JSON.parse(await channelMemberAddedData('bob', 'ana', true))).toEqual({
      newUsers: ['bob'],
    });
  });
});

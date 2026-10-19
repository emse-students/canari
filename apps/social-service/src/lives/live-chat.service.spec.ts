import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LiveEnabledGuard } from './live-enabled.guard';
import { LiveChatController } from './live-chat.controller';
import {
  parseChatMessageInput,
  parseReactionBurstInput,
  sumReactionBursts,
  type LiveChatService,
} from './live-chat.service';
import {
  LIVE_CHAT_SEALED_MAX_BYTES,
  LIVE_CHAT_SEALED_MIN_BYTES,
  LIVE_REACTION_KINDS,
  LIVE_REACTION_TAPS_PER_WINDOW,
  liveLimits,
} from './live.constants';
import type { LivesService } from './lives.service';
import type { AssociationsService } from '../associations/associations.service';

const UUID = '33333333-3333-4333-8333-333333333333';
const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64');

/** The status and body `code` of a thrown Nest exception. */
function refusal(f: () => unknown): { status: number; code?: string; field?: string } {
  try {
    f();
  } catch (e) {
    const err = e as {
      getStatus: () => number;
      getResponse: () => { code?: string; field?: string };
    };
    return { status: err.getStatus(), ...err.getResponse() };
  }
  throw new Error('expected a refusal');
}

describe('a live chat message body (WP-L6, C11)', () => {
  it('takes a uuid and the base64 of 29..928 sealed bytes, the uuid in lower case', () => {
    const out = parseChatMessageInput({ clientId: UUID.toUpperCase(), sealed: b64(100) });
    expect(out.clientId).toBe(UUID);
    expect(out.sealed.length).toBe(100);
    expect(
      parseChatMessageInput({ clientId: UUID, sealed: b64(LIVE_CHAT_SEALED_MIN_BYTES) }).sealed
    ).toHaveLength(29);
    expect(
      parseChatMessageInput({ clientId: UUID, sealed: b64(LIVE_CHAT_SEALED_MAX_BYTES) }).sealed
    ).toHaveLength(928);
  });

  it.each([
    ['no clientId', { sealed: b64(40) }, 'clientId'],
    ['a clientId that is not a uuid', { clientId: 'abc', sealed: b64(40) }, 'clientId'],
    ['no sealed', { clientId: UUID }, 'sealed'],
    ['a number for sealed', { clientId: UUID, sealed: 42 }, 'sealed'],
    ['an empty seal (overhead only)', { clientId: UUID, sealed: b64(28) }, 'sealed'],
    ['one byte over the bound', { clientId: UUID, sealed: b64(929) }, 'sealed'],
    [
      'a huge string, refused before decoding',
      { clientId: UUID, sealed: 'A'.repeat(1 << 20) },
      'sealed',
    ],
    ['not base64', { clientId: UUID, sealed: '!!!!'.repeat(10) }, 'sealed'],
    [
      'base64 without its padding',
      { clientId: UUID, sealed: b64(40).replace(/=+$/, '') + 'A' },
      'sealed',
    ],
  ])('refuses %s: 400 LIVE_MESSAGE_INVALID', (_name, body, field) => {
    expect(refusal(() => parseChatMessageInput(body))).toEqual({
      status: HttpStatus.BAD_REQUEST,
      code: 'LIVE_MESSAGE_INVALID',
      field,
    });
  });
});

describe('a reaction burst body (C6, C7, C8)', () => {
  it('takes known kinds with whole counts and sums the taps', () => {
    expect(parseReactionBurstInput({ burstId: UUID, counts: { like: 3, canari: 2 } })).toEqual({
      burstId: UUID,
      counts: { like: 3, canari: 2 },
      taps: 5,
    });
  });

  it.each([
    ['no burstId', { counts: { like: 1 } }],
    ['an unknown kind', { burstId: UUID, counts: { angry: 1 } }],
    ['a prototype key', { burstId: UUID, counts: JSON.parse('{"__proto__": 1}') }],
    ['a zero count', { burstId: UUID, counts: { like: 0 } }],
    ['a fraction', { burstId: UUID, counts: { like: 1.5 } }],
    ['a string count', { burstId: UUID, counts: { like: '2' } }],
    ['no tap at all', { burstId: UUID, counts: {} }],
    ['an array', { burstId: UUID, counts: [1] }],
    ['more taps than a window allows', { burstId: UUID, counts: { like: 6, love: 5 } }],
  ])('refuses %s: 400 LIVE_REACTION_INVALID', (_name, body) => {
    expect(refusal(() => parseReactionBurstInput(body))).toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      code: 'LIVE_REACTION_INVALID',
    });
  });

  it('caps one burst at the taps of a whole window', () => {
    expect(LIVE_REACTION_TAPS_PER_WINDOW).toBe(10);
    expect(parseReactionBurstInput({ burstId: UUID, counts: { like: 10 } }).taps).toBe(10);
  });
});

describe('the reaction sums a poll answers (C7, C10)', () => {
  const ME = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  const D = 'd'.repeat(64);

  it('is ONE sum per kind per window, ordered by window, leaving out my taps and a blocked account', () => {
    const out = sumReactionBursts(
      [
        { userId: B, window: 4, counts: { like: 2 } },
        { userId: C, window: 3, counts: { like: 1, laugh: 4 } },
        { userId: B, window: 4, counts: { like: 1, canari: 1 } },
        { userId: ME, window: 4, counts: { like: 9 } },
        { userId: D, window: 4, counts: { love: 5 } },
      ],
      ME,
      new Set([D])
    );
    expect(out).toEqual([
      { window: 3, counts: { like: 1, laugh: 4 } },
      { window: 4, counts: { like: 3, canari: 1 } },
    ]);
  });

  it('answers nothing for nothing', () => {
    expect(sumReactionBursts([], ME, new Set())).toEqual([]);
  });
});

describe('the chat numbers are published, not carried by a client', () => {
  it('serves the five kinds and the bounds from /api/lives/limits', () => {
    expect(liveLimits()).toMatchObject({
      chatMessageMaxChars: 300,
      chatSealedMaxBytes: LIVE_CHAT_SEALED_MAX_BYTES,
      chatMessagesPerWindow: 3,
      chatRateWindowMs: 5_000,
      chatBacklog: 50,
      reactionKinds: LIVE_REACTION_KINDS,
      reactionWindowMs: 2_000,
      reactionBurstsPerWindow: 2,
      reactionTapsPerWindow: 10,
    });
    expect([...LIVE_REACTION_KINDS]).toEqual(['like', 'love', 'laugh', 'happy', 'canari']);
  });
});

describe('LiveChatController', () => {
  const LIVE = '22222222-2222-4222-8222-222222222222';
  const mayWatch = jest.fn();
  const post = jest.fn().mockResolvedValue({ id: 'm' });
  const react = jest.fn().mockResolvedValue({ seq: 1 });
  const hide = jest.fn().mockResolvedValue({ hidden: true });
  /** The posts' one moderator predicate, faked: a global admin, or the BDE moderator `m...`. */
  const isContentModerator = jest.fn(
    async (userId: string, opts?: { isGlobalAdmin?: boolean }) =>
      opts?.isGlobalAdmin === true || userId.startsWith('m')
  );
  const controller = new LiveChatController(
    { mayWatch } as unknown as LivesService,
    { post, react, hide } as unknown as LiveChatService,
    { isContentModerator } as unknown as AssociationsService
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mayWatch.mockResolvedValue(undefined);
  });

  it('sits behind the same two guards as every live route, the switch first', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LiveChatController)).toEqual([
      LiveEnabledGuard,
      NginxAuthGuard,
    ]);
  });

  it('asks the watch rule BEFORE a message or a burst, with the caller in lower case', async () => {
    await controller.post(LIVE, 'A'.repeat(64), { clientId: UUID, sealed: 'x' });
    expect(mayWatch).toHaveBeenCalledWith('a'.repeat(64), LIVE);
    expect(post).toHaveBeenCalledWith('a'.repeat(64), LIVE, { clientId: UUID, sealed: 'x' });
    await controller.react(LIVE, 'A'.repeat(64), { burstId: UUID, counts: { like: 1 } });
    expect(react).toHaveBeenCalledWith('a'.repeat(64), LIVE, {
      burstId: UUID,
      counts: { like: 1 },
    });
  });

  it('writes nothing for a viewer the watch rule refuses', async () => {
    mayWatch.mockRejectedValue(new Error('refused'));
    await expect(controller.post(LIVE, 'a'.repeat(64), {})).rejects.toThrow('refused');
    await expect(controller.react(LIVE, 'a'.repeat(64), {})).rejects.toThrow('refused');
    expect(post).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });

  it('asks the posts\' ONE moderator predicate for staff, the admin header read as exactly "true"', async () => {
    await controller.hide(LIVE, UUID, 'a'.repeat(64), 'true');
    expect(isContentModerator).toHaveBeenLastCalledWith('a'.repeat(64), { isGlobalAdmin: true });
    expect(hide).toHaveBeenLastCalledWith('a'.repeat(64), true, LIVE, UUID);
    for (const value of [undefined, '', '1', 'TRUE']) {
      await controller.hide(LIVE, UUID, 'a'.repeat(64), value);
      expect(hide).toHaveBeenLastCalledWith('a'.repeat(64), false, LIVE, UUID);
    }
    // A BDE moderator with no admin header is staff too.
    await controller.hide(LIVE, UUID, 'M'.repeat(64), undefined);
    expect(hide).toHaveBeenLastCalledWith('m'.repeat(64), true, LIVE, UUID);
  });
});

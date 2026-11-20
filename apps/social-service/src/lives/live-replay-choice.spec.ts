import { BadRequestException } from '@nestjs/common';
import { LivesController } from './lives.controller';
import { parseReplayChoice } from './lives.service';
import type { LivesService } from './lives.service';
import type { AssociationsService } from '../associations/associations.service';
import type { LiveChatService } from './live-chat.service';

describe("the organiser's Rediffusion choice (owner, 2026-11-20)", () => {
  it('is ON when the start says nothing, and a boolean is taken as said', () => {
    expect(parseReplayChoice(undefined)).toBe(true);
    expect(parseReplayChoice(null)).toBe(true);
    expect(parseReplayChoice(true)).toBe(true);
    expect(parseReplayChoice(false)).toBe(false);
  });

  it('refuses anything that is not a boolean, with a typed code', () => {
    for (const bad of ['false', 0, 1, {}, []]) {
      expect(() => parseReplayChoice(bad)).toThrow(BadRequestException);
      expect(() => parseReplayChoice(bad)).toThrow(
        expect.objectContaining({ response: { code: 'LIVE_REPLAY_INVALID' } })
      );
    }
  });

  it('the off route hands the caller and the live id, lower case, to the service', async () => {
    const switchReplayOff = jest.fn(async (_u: string, id: string) => ({
      liveId: id,
      keepsReplay: false,
    }));
    const controller = new LivesController(
      { switchReplayOff } as unknown as LivesService,
      {} as unknown as AssociationsService,
      {} as unknown as LiveChatService
    );
    await expect(controller.switchReplayOff('ABC-ID', 'USER-1')).resolves.toEqual({
      liveId: 'abc-id',
      keepsReplay: false,
    });
    expect(switchReplayOff).toHaveBeenCalledWith('user-1', 'abc-id');
  });
});

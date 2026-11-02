import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_REEL_RETENTION_MS,
  CHAT_REEL_WRITER_ENABLED,
  captureCapMs,
  chatReelAllowed,
  ChatReelCapMissingError,
  servedChatCapMs,
  chatReelPendingDeclaration,
  chatReelPrepareOptions,
  chatReelTargetCap,
  isChatReelTake,
  markChatReelTake,
  uploadClassFor,
} from './chatReelWriter';
import { destinationRules } from './reelCapture';
import { REEL_TAKE_MAX_SENDS } from '$lib/db/sqliteBatch';

describe('the chat reel writer', () => {
  it('is OFF in a production build (no VITE_DEPLOY_ENVIRONMENT): production stays off', () => {
    expect(CHAT_REEL_WRITER_ENABLED).toBe(false);
    expect(chatReelAllowed(false)).toBe(false);
  });

  it.each([
    ['development', true],
    ['dev', true],
    ['production', false],
    ['prod', false],
    ['', false],
    ['staging', false],
  ])('VITE_DEPLOY_ENVIRONMENT=%j turns the writer %s', async (env, on) => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', env);
    vi.resetModules();
    try {
      const fresh = await import('./chatReelWriter');
      expect(fresh.CHAT_REEL_WRITER_ENABLED).toBe(on);
      expect(fresh.chatReelAllowed(false)).toBe(on);
      expect(fresh.chatReelAllowed(true)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('writes a DM or a group when on, never a salon', () => {
    expect(chatReelAllowed(false, true)).toBe(true);
    expect(chatReelAllowed(true, true)).toBe(false);
  });

  it('a RAW take queued at once (RC-5) declares its intent and expiry, and no length yet', () => {
    expect(chatReelPendingDeclaration(1_000)).toEqual({
      intent: 'reel-message',
      expiresAtMs: 1_000 + CHAT_REEL_RETENTION_MS,
    });
    expect(uploadClassFor(chatReelPendingDeclaration(0))).toBe('chat-reel');
  });

  it('uploads a declared reel as chat-reel and anything else as ephemeral', () => {
    expect(uploadClassFor({ intent: 'reel-message' })).toBe('chat-reel');
    expect(uploadClassFor({})).toBe('ephemeral');
  });

  it('marks a take by the file itself', () => {
    const take = new File(['x'], 'a.mp4', { type: 'video/mp4' });
    expect(isChatReelTake(take)).toBe(false);
    markChatReelTake(take);
    expect(isChatReelTake(take)).toBe(true);
    expect(isChatReelTake(new File(['x'], 'a.mp4', { type: 'video/mp4' }))).toBe(false);
  });

  it('keeps the chat camera photo-only unless the writer lets it film', () => {
    expect(destinationRules('chat').photoOnly).toBe(true);
    expect(destinationRules('chat', true)).toMatchObject({
      photoOnly: false,
      microphone: 'separate',
    });
    expect(destinationRules('feed', true).photoOnly).toBe(false);
  });

  it('caps a chat take at the chat cap the server serves, and every other destination at the reel cap', () => {
    const limits = { maxDurationMs: 90_000, chatMaxDurationMs: 60_000 };
    expect(servedChatCapMs(limits)).toBe(60_000);
    expect(captureCapMs(limits, 'chat')).toBe(60_000);
    expect(captureCapMs(limits, 'feed')).toBe(90_000);
    expect(captureCapMs(limits, 'post')).toBe(90_000);
    expect(captureCapMs(limits, 'post-edit')).toBe(90_000);
  });

  it('has NO fallback to the 90 s reel cap: an answer without a usable chat cap films nothing', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, '60000']) {
      const limits = { maxDurationMs: 90_000, chatMaxDurationMs: bad } as unknown as {
        maxDurationMs: number;
        chatMaxDurationMs: number;
      };
      expect(servedChatCapMs(limits)).toBeNull();
      expect(captureCapMs(limits, 'chat')).toBeNull();
      expect(captureCapMs(limits, 'feed')).toBe(90_000);
      expect(() => chatReelPrepareOptions(limits, 1)).toThrow(ChatReelCapMissingError);
    }
  });

  it('prepares a queued take at the chat profile under the chat cap (RC-3 wired into RC-5)', () => {
    expect(chatReelPrepareOptions({ chatMaxDurationMs: 60_000 }, 50_000_000)).toEqual({
      profile: 'chat',
      maxSeconds: 60,
      maxBytes: 50_000_000,
    });
  });

  it("caps RC-12's targets at the SMALLER of the server's count and what one take may carry, and offers none without a count", () => {
    expect(chatReelTargetCap({ chatReelMaxTargets: 15 })).toBe(15);
    expect(chatReelTargetCap({ chatReelMaxTargets: 500 })).toBe(REEL_TAKE_MAX_SENDS);
    for (const bad of [undefined, 0, -1, 2.5, Number.NaN, '15']) {
      expect(chatReelTargetCap({ chatReelMaxTargets: bad as unknown as number })).toBeNull();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_REEL_RETENTION_MS,
  CHAT_REEL_WRITER_ENABLED,
  captureCapMs,
  chatReelAllowed,
  chatReelCapMs,
  chatReelPendingDeclaration,
  chatReelPrepareOptions,
  isChatReelTake,
  markChatReelTake,
  uploadClassFor,
} from './chatReelWriter';
import { destinationRules } from './reelCapture';

describe('the chat reel writer', () => {
  it('is ON in the shipped code: a DM or a group films, a salon never does', () => {
    expect(CHAT_REEL_WRITER_ENABLED).toBe(true);
    expect(chatReelAllowed(false)).toBe(true);
    expect(chatReelAllowed(true)).toBe(false);
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
    expect(chatReelCapMs(limits)).toBe(60_000);
    expect(captureCapMs(limits, 'chat')).toBe(60_000);
    expect(captureCapMs(limits, 'feed')).toBe(90_000);
    expect(captureCapMs(limits, 'post')).toBe(90_000);
    expect(captureCapMs(limits, 'post-edit')).toBe(90_000);
  });

  it('says it when a server older than RC-3 serves no chat cap, and keeps its reel cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(chatReelCapMs({ maxDurationMs: 90_000 })).toBe(90_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no chat cap'));
    warn.mockRestore();
  });

  it('prepares a queued take at the chat profile under the chat cap (RC-3 wired into RC-5)', () => {
    expect(
      chatReelPrepareOptions({ maxDurationMs: 90_000, chatMaxDurationMs: 60_000 }, 50_000_000)
    ).toEqual({ profile: 'chat', maxSeconds: 60, maxBytes: 50_000_000 });
  });
});

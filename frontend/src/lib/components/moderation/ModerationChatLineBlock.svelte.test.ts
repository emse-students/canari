// @vitest-environment happy-dom
/**
 * THE ADMIN QUEUE'S CHAT-LINE ROW (WP-L8b): what a moderator reads about a reported live chat line
 * beside its preview. Pinned here: every integrity verdict has its own sentence (a line that is not
 * `verified` says WHY it shows no text), the live it was written in is named by a copyable id, and
 * an erased line says it was erased rather than drawing an empty block.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { ReportedLineVerdict, ReportedLiveChatLine } from '$lib/moderation/api';

const { copyId } = vi.hoisted(() => ({ copyId: vi.fn() }));
vi.mock('$lib/utils/copyId', () => ({ copyId }));

import ModerationChatLineBlock from './ModerationChatLineBlock.svelte';

const LIVE_ID = '0b6f3a2e-9c1d-4e5f-8a7b-1c2d3e4f5a6b';

function line(content: ReportedLineVerdict): ReportedLiveChatLine {
  return {
    liveId: LIVE_ID,
    messageId: '7c1d2e3f-0000-4000-8000-000000000001',
    seq: 4,
    authorId: '11111111-2222-4333-8444-555555555555',
    authorName: 'Alice',
    text: 'hello',
    messageCreatedAt: '2026-10-30T10:00:00.000Z',
    keptAt: '2026-10-30T10:01:00.000Z',
    keptUntil: '2027-01-28T10:01:00.000Z',
    integrity: { content, author: content, reporter: content },
  };
}

const mounted: (() => void)[] = [];

function render(value: ReportedLiveChatLine | null): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ModerationChatLineBlock, { target, props: { line: value } });
  flushSync();
  mounted.push(() => {
    unmount(component);
    target.remove();
  });
  return target;
}

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  copyId.mockReset();
});

describe('ModerationChatLineBlock', () => {
  const cases: [ReportedLineVerdict, () => string][] = [
    ['verified', () => m.moderation_chat_line_verified()],
    ['altered', () => m.moderation_chat_line_altered()],
    ['key-rotated', () => m.moderation_chat_line_key_rotated()],
    ['unverifiable', () => m.moderation_chat_line_unverifiable()],
  ];

  for (const [verdict, text] of cases) {
    it(`says what a ${verdict} line means`, () => {
      const el = render(line(verdict));
      const badge = el.querySelector(`[data-moderation-chat-line-integrity="${verdict}"]`);
      expect(badge, verdict).not.toBeNull();
      expect(badge!.textContent!.trim()).toBe(text());
    });
  }

  it('names the live by its id, and copies it on a click', () => {
    const el = render(line('verified'));
    const button = el.querySelector<HTMLButtonElement>('[data-moderation-chat-line-live]');
    expect(button?.textContent).toContain(LIVE_ID);
    button!.click();
    expect(copyId).toHaveBeenCalledWith(LIVE_ID);
  });

  it('says an erased line was erased, with no badge and no live', () => {
    const el = render(null);
    expect(el.querySelector('[data-moderation-chat-line-erased]')?.textContent?.trim()).toBe(
      m.moderation_chat_line_erased()
    );
    expect(el.querySelector('[data-moderation-chat-line-integrity]')).toBeNull();
    expect(el.querySelector('[data-moderation-chat-line-live]')).toBeNull();
  });
});

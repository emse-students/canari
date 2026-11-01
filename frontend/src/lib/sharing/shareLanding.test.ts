import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A share's landing only PUBLISHES its target: the landing effect in `ChatBackgroundService` routes
 * and selects. A `goto` from here, on a phone already on the target's route, drained the overlay
 * stack after the effect had opened the conversation - the share sat in a composer nobody saw.
 */
const goto = vi.fn(async () => {});
vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...(args as [])) }));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: () => {} }));

const { notifNav } = await import('$lib/stores/notifNav.svelte');
const { landShareOn } = await import('./shareLanding');

describe('landShareOn', () => {
  beforeEach(() => {
    goto.mockClear();
    notifNav.clear();
  });

  it('publishes the conversation as a new landing', () => {
    const before = notifNav.landing;
    landShareOn('group-1');
    expect(notifNav.pending).toBe('group-1');
    expect(notifNav.landing).toBe(before + 1);
  });

  it('never navigates itself, so nothing drains the conversation the landing opens', () => {
    landShareOn('group-1');
    landShareOn('channel_abc');
    expect(goto).not.toHaveBeenCalled();
  });
});

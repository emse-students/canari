// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { flushSync } from 'svelte';
import { APP_FOREGROUND_EVENT, isAppInForeground } from './appForeground';
import { createAppForegroundState } from './appForegroundState.svelte';

/**
 * AN ANDROID APP RESUMED ON AN OPEN CONVERSATION MARKS IT READ (owner, 2026-11-02).
 *
 * `MainChatPage`'s receipt effect asked `isAppInForeground()`, a plain global the Android activity
 * writes. A global is not reactive: the effect that returned early while the app was in the
 * background was never run again when it came back, so a message that landed in the background in
 * the conversation left open stayed unread - on this phone's badge and, the mark never being sent,
 * on every other device of the account - until something else changed the conversation.
 */

function announce(foreground: boolean) {
  (window as unknown as Record<string, unknown>).__canariForeground = foreground;
  window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground } }));
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__canariForeground;
});

describe('the app foreground, as something an effect can follow', () => {
  it('THE CAUSE: an effect reading the bare global is not run again when the app comes back', () => {
    announce(false);
    const seen: boolean[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(isAppInForeground());
      });
    });
    try {
      flushSync();
      announce(true);
      flushSync();
      expect(seen).toEqual([false]);
    } finally {
      stop();
    }
  });

  it('re-runs an effect that reads it when the app comes back to the foreground', () => {
    announce(false);
    const foreground = createAppForegroundState();
    const seen: boolean[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        seen.push(foreground.current);
      });
    });
    try {
      flushSync();
      announce(true);
      flushSync();
      announce(false);
      flushSync();
      expect(seen).toEqual([false, true, false]);
    } finally {
      stop();
      foreground.destroy();
    }
  });

  it('starts from the fact the activity already wrote, not from a default', () => {
    announce(false);
    const foreground = createAppForegroundState();
    try {
      expect(foreground.current).toBe(false);
    } finally {
      foreground.destroy();
    }
  });

  it('is true, and stays true, on a runtime that never writes the flag', () => {
    const foreground = createAppForegroundState();
    try {
      expect(foreground.current).toBe(true);
    } finally {
      foreground.destroy();
    }
  });

  it('stops listening once destroyed', () => {
    announce(true);
    const foreground = createAppForegroundState();
    foreground.destroy();
    announce(false);
    expect(foreground.current).toBe(true);
  });

  it("is what MainChatPage's receipt effect reads, never the bare global", () => {
    const source = readFileSync('src/lib/components/MainChatPage.svelte', 'utf8');
    const note = source.indexOf('readMarks.note(');
    const effectStart = source.lastIndexOf('$effect(() => {', note);
    const effect = source.slice(effectStart, note);
    expect(effect).toContain('appForeground.current');
    expect(effect).not.toContain('isAppInForeground()');
  });
});

// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { flushSync } from 'svelte';

/**
 * LEAVING A CONVERSATION INSIDE ITS READ-MARK WINDOW IS SEEN AT THE START OF THE RECEIPT EFFECT'S
 * RUN, NEVER IN ITS TEARDOWN (2026-10-27).
 *
 * `MainChatPage`'s receipt effect used to detect the leave in its teardown, with
 * `convs.selectedContact !== currentContact`. Svelte hands a `$state` read in a teardown the value the
 * effect last saw, so that comparison was never true and nothing was delivered on leave. The first
 * case pins that Svelte behaviour; the second pins that the effect asks `readMarks.follow` FIRST,
 * before any early return could skip it (what it then does is `readMarkDebounce.test.ts`).
 */
describe('the receipt effect leaving a conversation', () => {
  it('cannot be seen from a teardown: a $state read there returns the value before the change', () => {
    let selected = $state('A');
    const seenInTeardown: string[] = [];
    const stop = $effect.root(() => {
      $effect(() => {
        void selected;
        return () => seenInTeardown.push(selected);
      });
    });
    try {
      flushSync();
      selected = 'B';
      flushSync();
      expect(seenInTeardown).toEqual(['A']);
    } finally {
      stop();
    }
  });

  it("is asked of `readMarks.follow` as the receipt effect's first statement, with no return before it", () => {
    const source = readFileSync('src/lib/components/MainChatPage.svelte', 'utf8');
    const note = source.indexOf('readMarks.note(');
    expect(note).toBeGreaterThan(0);
    const effectStart = source.lastIndexOf('$effect(() => {', note);
    const follow = source.indexOf('readMarks.follow(', effectStart);
    expect(follow).toBeGreaterThan(effectStart);
    expect(follow).toBeLessThan(note);
    // No statement before the call can return: comments stripped, the code between the effect's
    // opening and the call holds no `return`.
    const before = source
      .slice(effectStart + '$effect(() => {'.length, follow)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(before).not.toMatch(/\breturn\b/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SEQUENCE THE TAB BAR'S ASYNC COMMANDS ARE ORDERED BY. Swift's `CommandSequence` drops a call
 * older than the last it applied, so this side owes exactly one thing: every call, whatever the
 * command, carries a `seq` higher than every call before it. The Swift half is pinned by
 * `systemComponentsPatch.test.ts`; whether UIKit ends in the newest state is owed on an iPhone.
 */
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

import { invokeSequenced } from './systemComponentsCommands';

const seqOf = (call: unknown[]) => (call[1] as { options: { seq: number } }).options.seq;

beforeEach(() => {
  core.invoke.mockReset().mockResolvedValue(undefined);
});

describe('invokeSequenced', () => {
  it('invokes the patched command by name, with its fields and a seq in `options`', async () => {
    const { seq, answered } = invokeSequenced('setTabBarInteractive', { interactive: false });
    await answered;
    expect(core.invoke).toHaveBeenCalledExactlyOnceWith(
      'plugin:system-components|set_tab_bar_interactive',
      { options: { interactive: false, seq } }
    );
  });

  it('sends show and hide with a seq alone - the published API sends no argument at all', () => {
    invokeSequenced('hideTabBar');
    invokeSequenced('showTabBar');
    expect(core.invoke.mock.calls.map(([command]) => command)).toEqual([
      'plugin:system-components|hide_tab_bar',
      'plugin:system-components|show_tab_bar',
    ]);
    for (const call of core.invoke.mock.calls) {
      expect(Object.keys((call[1] as { options: object }).options)).toEqual(['seq']);
    }
  });

  it('stamps ONE rising sequence across every command, so the newest call always wins', () => {
    // The race of the backlog: a hide quickly followed by a show, with the interaction switch
    // between them - each later call is newer than every one before it, whatever its command.
    const returned = [
      invokeSequenced('hideTabBar').seq,
      invokeSequenced('setTabBarInteractive', { interactive: true }).seq,
      invokeSequenced('showTabBar').seq,
      invokeSequenced('hideTabBar').seq,
    ];
    const sent = core.invoke.mock.calls.map(seqOf);
    expect(sent).toEqual(returned);
    for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeGreaterThan(sent[i - 1]);
    // Swift's sequence starts at -1, so even the first call of a page is admitted.
    expect(sent[0]).toBeGreaterThan(0);
  });

  it('returns the answer of the invoke, so a refusal reaches the caller', async () => {
    core.invoke.mockRejectedValueOnce(new Error('tab bar is not configured'));
    await expect(invokeSequenced('showTabBar').answered).rejects.toThrow('not configured');
  });
});

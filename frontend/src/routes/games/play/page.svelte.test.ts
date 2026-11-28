// @vitest-environment happy-dom
/**
 * THE GAME ROUTE ASKS THE MODE (owner, 2026-11-28: "when I press Jouer, the ranked / unranked modal does not
 * appear"). The modal used to open only at the very first game on a device, so any player with a trace of
 * history pressed "Jouer" and landed on the board with a mode chosen for them. Arriving at `/games/play` IS
 * launching a game: the modal opens, whatever the device holds, on the stored mode.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

vi.mock('$lib/minesweeper/api', () => ({
  startMinesweeperChallenge: vi.fn(),
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
  MinesweeperUpdateRequiredError: class extends Error {},
}));

import Page from './+page.svelte';

afterAll(adoptTransitionAnimations());

let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  app = mount(Page, { target: document.body });
  flushSync();
  await tick();
}

const modal = () => document.querySelector<HTMLElement>('[data-testid="mode-modal"]');

describe('/games/play', () => {
  it('asks ranked or training on a device that has never played', async () => {
    await open();
    expect(modal()).not.toBeNull();
  });

  it('asks it again for a returning player, a stored mode and a level included, on the stored mode', async () => {
    localStorage.setItem('canari.minesweeper.unranked', '0');
    localStorage.setItem('canari.minesweeper.level', 'expert');
    await open();
    expect(modal()).not.toBeNull();
    expect(
      modal()!.querySelector('[data-mode][aria-checked="true"]')?.getAttribute('data-mode')
    ).toBe('ranked');
  });
});

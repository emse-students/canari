import { describe, expect, it } from 'vitest';
import type { PublishView } from './publishQueue';
import { PublishScreenHold, publishHoldsTheScreen } from './publishScreenHold';

const row = (phase: PublishView['phase']): PublishView => ({
  id: phase,
  phase,
  index: 0,
  count: 1,
  fraction: 0,
  step: 0,
});

describe('publishHoldsTheScreen', () => {
  it.each(['preparing', 'uploading', 'publishing'] as const)(
    'holds the screen while a post is %s',
    (phase) => {
      expect(publishHoldsTheScreen([row('paused'), row(phase)])).toBe(true);
    }
  );

  it.each(['queued', 'waiting', 'paused', 'withdrawing', 'failed'] as const)(
    'never holds it for a post that is %s: a queue that cannot progress keeps no phone awake',
    (phase) => {
      expect(publishHoldsTheScreen([row(phase)])).toBe(false);
    }
  );

  it('an empty queue holds nothing', () => {
    expect(publishHoldsTheScreen([])).toBe(false);
  });
});

/** A platform hold that REFUSES, as `ScreenWakeLock` does on a page the engine will not wake. */
function refusingScreen() {
  const screen = {
    asked: 0,
    released: 0,
    async hold() {
      screen.asked += 1;
      throw new Error('NotAllowedError: the wake lock was refused');
    },
    release() {
      screen.released += 1;
    },
  };
  return screen;
}

function holdOver(visible = { on: true }) {
  const screen = refusingScreen();
  const logs: string[] = [];
  const hold = new PublishScreenHold(
    {
      hold: () => screen.hold().catch(() => undefined),
      release: () => screen.release(),
    },
    () => visible.on,
    (line) => logs.push(line)
  );
  return { hold, screen, logs, visible };
}

describe('PublishScreenHold', () => {
  it('a REFUSED lock is asked exactly once across N progress updates of one upload', async () => {
    const { hold, screen } = holdOver();
    for (let i = 0; i < 50; i++) hold.rows([{ ...row('uploading'), step: i / 50 }]);
    await Promise.resolve();
    expect(screen.asked).toBe(1);
  });

  it('asks again only on a NEW want: after nothing was worked on, or on a return to visible', () => {
    const { hold, screen, visible } = holdOver();
    hold.rows([row('preparing')]);
    hold.rows([row('uploading')]);
    hold.rows([row('waiting')]);
    expect(screen.released).toBe(1);
    hold.rows([row('uploading')]);
    expect(screen.asked).toBe(2);
    visible.on = false;
    hold.becameVisible();
    expect(screen.asked).toBe(2);
    visible.on = true;
    hold.becameVisible();
    expect(screen.asked).toBe(3);
  });

  it('a want born on a hidden page is not asked until the page is visible', () => {
    const { hold, screen, visible } = holdOver({ on: false });
    hold.rows([row('uploading')]);
    expect(screen.asked).toBe(0);
    visible.on = true;
    hold.becameVisible();
    expect(screen.asked).toBe(1);
  });

  it('the END OF THE PASS releases a screen its last rows still held, and a return to visible then asks nothing', () => {
    const { hold, screen } = holdOver();
    hold.rows([row('uploading')]);
    hold.passEnded();
    expect(screen.released).toBe(1);
    hold.becameVisible();
    expect(screen.asked).toBe(1);
  });

  it('the end of a pass that held nothing releases nothing twice', () => {
    const { hold, screen } = holdOver();
    hold.passEnded();
    expect(screen.released).toBe(0);
  });
});

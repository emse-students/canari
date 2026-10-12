import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE LANDING MUST SAY WHEN IT HAS ARRIVED, or the feed's first-draw hold never ends.
 *
 * `notifNav.enRoute` turns false only through `markArrived()` (or `clear()`), and the one place that
 * knows the route was reached is the landing effect, at `landingStep` = `select`. A review found the
 * first version of the hold keyed on `pending`, which a successful landing never clears on a wide
 * screen - the feed then showed skeletons for ever (2026-10-12). Same technique and reasoning as
 * `pinFirstSetupRefuted.test.ts`: what breaks is a missing statement in a component, which a source
 * guard pins and a render harness would only mock.
 */
// FROM `process.cwd()`, for the reason the sibling guards state.
const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

describe('the landing effect marks its arrival', () => {
  it('marks the landing arrived as soon as its route is reached, before anything can return', () => {
    const select = source.indexOf("if (step !== 'select') return;");
    expect(select).toBeGreaterThan(-1);
    const after = source.slice(select, select + 400);
    const mark = after.indexOf('notifNav.markArrived()');
    expect(mark).toBeGreaterThan(-1);
    // Nothing between the step check and the mark may leave the effect early.
    expect(after.slice("if (step !== 'select') return;".length, mark)).not.toMatch(/return/);
  });
});

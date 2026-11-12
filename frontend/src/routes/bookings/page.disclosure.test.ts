import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('the bookings page', () => {
  it('folds past bookings behind a styled disclosure, not the native triangle', () => {
    expect(page).toContain('list-none');
    expect(page).toContain('[&::-webkit-details-marker]:hidden');
    expect(page).toMatch(/<ChevronDown[^>]*group-not-open\/history:-rotate-90/s);
  });

  it('gives the notification note an icon card so it is not a lone footer line', () => {
    expect(page).toMatch(/<Bell [^>]*\/>\s*\{BOOKING_NOTIFICATIONS_LIVE/);
  });
});

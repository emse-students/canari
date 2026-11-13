import { redirect } from '@sveltejs/kit';

/**
 * `/events` was a static "no event yet" stub with no data behind it, which contradicted the
 * calendar listing the same account's upcoming events (tour of dev, 2026-11-10). The calendar is
 * where events live, so the old address leads there.
 */
export function load() {
  redirect(302, '/calendar');
}

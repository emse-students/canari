// @vitest-environment happy-dom
/** The admin's free text is truncated on one line, so the whole of it is in the title and an sr-only copy. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  getAppVersionCheck: () => ({ maintenance: { message: 'Back at 18:00, sorry for the wait' } }),
}));

import MaintenanceAdminBanner from './MaintenanceAdminBanner.svelte';

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = '';
});

describe('MaintenanceAdminBanner', () => {
  it('keeps the whole message in the tooltip and in a screen-reader-only copy', () => {
    app = mount(MaintenanceAdminBanner, { target: document.body });
    flushSync();
    const visible = document.body.querySelector('span.truncate')!;
    const sr = document.body.querySelector('span.sr-only')!;
    expect(visible.getAttribute('title')).toContain('Back at 18:00, sorry for the wait');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(sr.textContent).toBe(visible.getAttribute('title'));
  });
});

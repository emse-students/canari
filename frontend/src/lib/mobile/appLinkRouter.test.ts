// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { processAppLinks } from './appLinkRouter';

const goto = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));

/** A promise the test resolves by hand: the router's first navigation settling. */
function gate() {
  let open: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

/**
 * A COLD-START TAP ON A PAGE LINK WAITS FOR THE ROUTER (owner's Android log, 2026-11-25): the link
 * arrived before the first navigation settled, `goto` threw on SvelteKit's null current URL, and the
 * tap on an admin notification landed nowhere. Every branch waits for the same signal.
 */
describe('processAppLinks waits for the router before it navigates', () => {
  beforeEach(() => {
    goto.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('a page link delivered before the router is ready navigates once it is ready', async () => {
    const { ready, open } = gate();
    processAppLinks([`${MOBILE_APP_PROTOCOL}//admin-agenda`], ready);
    // Nothing navigates while the first navigation is still running, however long it takes.
    await new Promise((r) => setTimeout(r, 0));
    expect(goto).not.toHaveBeenCalled();
    open();
    await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
    expect(goto).toHaveBeenCalledWith('/admin/agenda');
  });

  it('a page link delivered once the router is ready navigates at once, exactly once', async () => {
    processAppLinks([`${MOBILE_APP_PROTOCOL}//notifications`], Promise.resolve());
    await vi.waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
    expect(goto).toHaveBeenCalledWith('/notifications');
  });
});

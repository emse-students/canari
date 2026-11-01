import { beforeEach, describe, expect, it, vi } from 'vitest';

type Nav = { type: string; to: { url: URL } | null; cancel: () => void };
const hooks: ((nav: Nav) => void)[] = [];
const goto = vi.fn(async (_href: string) => {});
const confirm = vi.fn(async (_message: string, _opts?: unknown) => true);

vi.mock('$app/navigation', () => ({
  beforeNavigate: (cb: (nav: Nav) => void) => hooks.push(cb),
  goto: (href: string) => goto(href),
}));
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: (message: string, opts?: unknown) => confirm(message, opts),
}));

const { guardUnsavedChanges } = await import('./unsavedChanges');

function navigate(type: string, path: string | null) {
  const nav = {
    type,
    to: path ? { url: new URL(`https://app.test${path}`) } : null,
    cancel: vi.fn(),
  };
  for (const hook of hooks) hook(nav);
  return nav;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('guardUnsavedChanges', () => {
  beforeEach(() => {
    hooks.length = 0;
    goto.mockClear();
    confirm.mockClear();
    confirm.mockResolvedValue(true);
  });

  it('lets everything through while nothing is unsaved', () => {
    guardUnsavedChanges(
      () => false,
      () => 'unsaved'
    );
    expect(navigate('link', '/x').cancel).not.toHaveBeenCalled();
    expect(navigate('leave', null).cancel).not.toHaveBeenCalled();
  });

  it("hands a tab close to the browser's own prompt", () => {
    guardUnsavedChanges(
      () => true,
      () => 'unsaved'
    );
    expect(navigate('leave', null).cancel).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('holds an in-app navigation, asks, and replays it once confirmed', async () => {
    guardUnsavedChanges(
      () => true,
      () => 'unsaved'
    );
    const nav = navigate('link', '/bookings?x=1#top');
    expect(nav.cancel).toHaveBeenCalled();
    await settle();
    expect(confirm).toHaveBeenCalledWith('unsaved', { danger: true });
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/bookings?x=1#top'));
    // The replayed navigation is not asked a second time.
    expect(navigate('goto', '/bookings').cancel).not.toHaveBeenCalled();
  });

  it('stays when the reader declines', async () => {
    confirm.mockResolvedValue(false);
    guardUnsavedChanges(
      () => true,
      () => 'unsaved'
    );
    navigate('popstate', '/back');
    await settle();
    expect(goto).not.toHaveBeenCalled();
  });

  it('lets a leave the editor decided through unasked', () => {
    const guard = guardUnsavedChanges(
      () => true,
      () => 'unsaved'
    );
    guard.release();
    expect(navigate('goto', '/').cancel).not.toHaveBeenCalled();
  });
});

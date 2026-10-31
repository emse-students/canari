import { captureGroupReadyAnnouncer, setGroupReadyAnnouncer } from './groupReadyAnnouncer';

describe('groupReadyAnnouncer', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    setGroupReadyAnnouncer(null);
    warn.mockRestore();
  });

  it('reaches the session live when the recovery was built, for the callers built outside it', () => {
    const announce = vi.fn();
    setGroupReadyAnnouncer(announce);

    captureGroupReadyAnnouncer()('group-1');

    expect(announce).toHaveBeenCalledWith('group-1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a recovery started in one session never announces into the next', () => {
    const first = vi.fn();
    const second = vi.fn();
    setGroupReadyAnnouncer(first);
    const onGroupReady = captureGroupReadyAnnouncer();

    // Sign-out and the next sign-in while the join is in flight.
    setGroupReadyAnnouncer(null);
    setGroupReadyAnnouncer(second);
    onGroupReady('group-1');

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ended since'));
  });

  it('a recovery built with no live session announces nothing when a session starts later, and says so', () => {
    const onGroupReady = captureGroupReadyAnnouncer();
    const later = vi.fn();
    setGroupReadyAnnouncer(later);

    onGroupReady('group-1');

    expect(later).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('none at the start'));
  });
});

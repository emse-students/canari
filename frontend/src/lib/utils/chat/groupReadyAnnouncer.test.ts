import { announceGroupReadyToSession, setGroupReadyAnnouncer } from './groupReadyAnnouncer';

describe('groupReadyAnnouncer', () => {
  afterEach(() => setGroupReadyAnnouncer(null));

  it("reaches the live session's announcer, for the callers built outside the session", () => {
    const announce = vi.fn();
    setGroupReadyAnnouncer(announce);

    announceGroupReadyToSession('group-1');

    expect(announce).toHaveBeenCalledWith('group-1');
  });

  it('says so when no session is live, and calls the torn-down announcer no more', () => {
    const announce = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setGroupReadyAnnouncer(announce);
    setGroupReadyAnnouncer(null);

    announceGroupReadyToSession('group-1');

    expect(announce).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('with no live session'));
    warn.mockRestore();
  });
});

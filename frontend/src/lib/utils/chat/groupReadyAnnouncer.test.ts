import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureGroupReadyAnnouncer, setGroupReadyAnnouncer } from './groupReadyAnnouncer';

describe('groupReadyAnnouncer', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    setGroupReadyAnnouncer(null);
    warn.mockRestore();
    info.mockRestore();
  });

  it('reaches the session live when the deps were built', () => {
    const announce = vi.fn();
    setGroupReadyAnnouncer(announce);

    captureGroupReadyAnnouncer()('group-1');

    expect(announce).toHaveBeenCalledWith('group-1');
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('work started in one session never announces into the next - an ordinary sign-out, said at info', () => {
    const first = vi.fn();
    const second = vi.fn();
    setGroupReadyAnnouncer(first);
    const onGroupReady = captureGroupReadyAnnouncer();

    // Sign-out and the next sign-in while the join, or the Welcome, is in flight.
    setGroupReadyAnnouncer(null);
    setGroupReadyAnnouncer(second);
    onGroupReady('group-1');

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('session that asked for it ended'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('a session re-registering the SAME function is still a new session', () => {
    const announce = vi.fn();
    setGroupReadyAnnouncer(announce);
    const onGroupReady = captureGroupReadyAnnouncer();
    setGroupReadyAnnouncer(null);
    setGroupReadyAnnouncer(announce);

    onGroupReady('group-1');

    expect(announce).not.toHaveBeenCalled();
  });

  it('work built with no live session announces nothing when a session starts later, and warns', () => {
    const onGroupReady = captureGroupReadyAnnouncer();
    const later = vi.fn();
    setGroupReadyAnnouncer(later);

    onGroupReady('group-1');

    expect(later).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no live session'));
  });

  /**
   * THE CHECK IS THE SEAM, so no `onGroupReady` may reach the session's implementation around it
   * (review of #2808: the in-session bags called `announceGroupReady` directly, so a recovery or a
   * Welcome landing after a sign-out still resumed the next session's outbox).
   */
  it('every onGroupReady built in the app is the captured announcer', () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    const sites = [
      '../../composables/session/sessionAuth.ts',
      '../../composables/useConversations.svelte.ts',
      './groupCreation.ts',
    ];
    let total = 0;
    for (const site of sites) {
      const assignments = read(site).match(/onGroupReady:\s*[^,\n]+/g) ?? [];
      for (const a of assignments) {
        expect(a, site).toMatch(/onGroupReady:\s*captureGroupReadyAnnouncer\(\)/);
      }
      total += assignments.length;
    }
    // sessionAuth (the recovery bag, the message pipeline), useConversations, groupCreation.
    expect(total).toBe(4);
    expect(read('../../composables/session/sessionAuth.ts')).not.toMatch(
      /export function announceGroupReady/
    );
  });
});

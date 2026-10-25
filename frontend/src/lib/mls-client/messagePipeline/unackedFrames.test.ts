import {
  dischargeRefusedBacklog,
  noteUnackedFrame,
  rearmRefusedBacklog,
  refusedBacklogIsQueued,
  refusedBacklogMark,
  reportUnackedFrames,
  resetUnackedFrames,
  takeGroupAwaiting,
  takeGroupsAwaiting,
} from './unackedFrames';

beforeEach(() => resetUnackedFrames());

describe('unacknowledged-frame tally', () => {
  it('says nothing when a drain left nothing behind', () => {
    const log = vi.fn();
    reportUnackedFrames(log);
    expect(log).not.toHaveBeenCalled();
  });

  it('reports the COUNT, not one line per frame - a backlog is where per-frame logging fails', () => {
    for (let i = 0; i < 480; i++) noteUnackedFrame('group-aaaaaaaa', 'unknown-group');
    const log = vi.fn();
    reportUnackedFrames(log);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('480 frame(s) left unacknowledged');
    expect(log.mock.calls[0][0]).toContain('unknown-group: 480');
  });

  it('keeps the two reasons apart - they call for different fixes', () => {
    noteUnackedFrame('g1', 'unknown-group');
    noteUnackedFrame('g2', 'absent-conversation');
    noteUnackedFrame('g2', 'absent-conversation');
    const log = vi.fn();
    reportUnackedFrames(log);

    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('unknown-group: 1');
    expect(line).toContain('absent-conversation: 2');
  });

  it('names the groups, so the report points somewhere', () => {
    noteUnackedFrame('deadbeefcafe', 'unknown-group');
    const log = vi.fn();
    reportUnackedFrames(log);

    expect(log.mock.calls[0][0]).toContain('deadbeef');
  });

  it('resets between drains, so a report covers one drain and not the session', () => {
    noteUnackedFrame('g1', 'unknown-group');
    reportUnackedFrames(vi.fn());

    const log = vi.fn();
    reportUnackedFrames(log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('the work list behind the retry', () => {
  it('hands back the FULL group ids, not the ids the report truncates', () => {
    // The report is for a human and shows eight characters; a re-fetch is for the server.
    noteUnackedFrame('deadbeef-cafe-0000-0000-000000000001', 'unknown-group');
    expect(takeGroupsAwaiting('unknown-group')).toEqual(['deadbeef-cafe-0000-0000-000000000001']);
  });

  it('keeps the reasons apart, because a different event discharges each', () => {
    noteUnackedFrame('g1', 'unknown-group');
    noteUnackedFrame('g2', 'absent-conversation');

    expect(takeGroupsAwaiting('unknown-group')).toEqual(['g1']);
    expect(takeGroupsAwaiting('absent-conversation')).toEqual(['g2']);
  });

  it('keeps a key group waiting for its roster apart from one waiting for a conversation', () => {
    // A registration naming the scope discharges the first; nothing but a conversation appearing
    // discharges the second, and a key group never gets one - merged, one would starve the other.
    noteUnackedFrame('g1', 'unscoped-distribution-group');
    noteUnackedFrame('g2', 'absent-conversation');

    expect(takeGroupsAwaiting('unscoped-distribution-group')).toEqual(['g1']);
    expect(takeGroupsAwaiting('absent-conversation')).toEqual(['g2']);
  });

  it('counts a group once however many of its frames were left behind', () => {
    for (let i = 0; i < 40; i++) noteUnackedFrame('g1', 'unknown-group');
    expect(takeGroupsAwaiting('unknown-group')).toEqual(['g1']);
  });

  it('is EMPTIED by the taking, so one event does not re-fetch for ever', () => {
    noteUnackedFrame('g1', 'unknown-group');
    takeGroupsAwaiting('unknown-group');

    expect(takeGroupsAwaiting('unknown-group')).toEqual([]);
  });

  it('survives a report, which is a log line and not an action', () => {
    // The tally and the work list are separate on purpose: a report that cancelled a pending
    // re-fetch would make the retry depend on whether anybody was reading.
    noteUnackedFrame('g1', 'unknown-group');
    reportUnackedFrames(vi.fn());

    expect(takeGroupsAwaiting('unknown-group')).toEqual(['g1']);
  });

  it('is refilled by the next frame that fails, so nothing is lost by clearing', () => {
    noteUnackedFrame('g1', 'unknown-group');
    takeGroupsAwaiting('unknown-group');
    noteUnackedFrame('g1', 'unknown-group');

    expect(takeGroupsAwaiting('unknown-group')).toEqual(['g1']);
  });

  it('is dropped entirely by the reset, for logout', () => {
    noteUnackedFrame('g1', 'unknown-group');
    resetUnackedFrames();

    expect(takeGroupsAwaiting('unknown-group')).toEqual([]);
  });
});

/**
 * The gap healer asks whether frames refused for lack of a row are still to come before it replays
 * commits past their epochs - 47 of them were lost that way (Pixel 6a, prod 1.2.7, 2026-10-14).
 */
describe('the refused backlog the gap healer waits behind', () => {
  it('is marked by an absent-conversation refusal and by nothing else', () => {
    noteUnackedFrame('g1', 'absent-conversation');
    noteUnackedFrame('g2', 'unknown-group');

    expect(refusedBacklogIsQueued('g1')).toBe(true);
    expect(refusedBacklogIsQueued('g2')).toBe(false);
  });

  it('outlives the re-fetch that is TAKEN for it - the frames it asked for are still on the wire', () => {
    noteUnackedFrame('g1', 'absent-conversation');
    takeGroupsAwaiting('absent-conversation');

    expect(refusedBacklogIsQueued('g1')).toBe(true);
  });

  it('is discharged by a pull that started after the refusal', () => {
    noteUnackedFrame('g1', 'absent-conversation');
    const pullStart = refusedBacklogMark();

    dischargeRefusedBacklog(pullStart);

    expect(refusedBacklogIsQueued('g1')).toBe(false);
  });

  it('survives a pull that started BEFORE the refusal, which cannot have listed that frame', () => {
    const pullStart = refusedBacklogMark();
    noteUnackedFrame('g1', 'absent-conversation');

    dischargeRefusedBacklog(pullStart);

    expect(refusedBacklogIsQueued('g1')).toBe(true);
  });

  it('a pull that DIED HALF-WAY re-arms its groups, so the next event pulls again', () => {
    noteUnackedFrame('g1', 'absent-conversation');
    // The event that started the pull took the group off the work list.
    expect(takeGroupAwaiting('absent-conversation', 'g1')).toBe(true);
    const pullStart = refusedBacklogMark();

    // It never listed the whole mailbox: the mark stands, and nothing was left to start a pull.
    expect(takeGroupAwaiting('absent-conversation', 'g1')).toBe(false);
    rearmRefusedBacklog(pullStart);

    expect(refusedBacklogIsQueued('g1')).toBe(true);
    expect(takeGroupAwaiting('absent-conversation', 'g1')).toBe(true);
  });

  it('re-arms only what that pull was meant to cover, and adds nothing to the tally', () => {
    const pullStart = refusedBacklogMark();
    noteUnackedFrame('g2', 'absent-conversation');
    takeGroupsAwaiting('absent-conversation');
    const log = vi.fn();
    reportUnackedFrames(log);
    log.mockClear();

    rearmRefusedBacklog(pullStart);

    expect(takeGroupsAwaiting('absent-conversation')).toEqual([]);
    reportUnackedFrames(log);
    expect(log).not.toHaveBeenCalled();
  });

  it('a frame refused again while the pull is handled marks its group again', () => {
    noteUnackedFrame('g1', 'absent-conversation');
    const pullStart = refusedBacklogMark();
    noteUnackedFrame('g1', 'absent-conversation');

    dischargeRefusedBacklog(pullStart);

    expect(refusedBacklogIsQueued('g1')).toBe(true);
  });
});

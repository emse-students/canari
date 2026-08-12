import { noteUnackedFrame, reportUnackedFrames, resetUnackedFrames } from './unackedFrames';

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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  drainForkFindings,
  noteIntegrityFinding,
  recordedIntegrityFindings,
  resetIntegrityFindings,
  setIntegrityFindingReporter,
} from './integrityFindings';

afterEach(() => {
  setIntegrityFindingReporter(null);
  resetIntegrityFindings();
});

describe('integrity findings', () => {
  it('turns what mls-core recorded after a same-epoch refusal into reported fork findings', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    setIntegrityFindingReporter(report);
    const log = vi.fn();
    const taken = await drainForkFindings(
      {
        takeForkFindings: async () => [
          { kind: 'fork', groupId: 'g-1', epoch: 2, peer: 'alice:dev1', detail: '' },
        ],
      },
      log
    );
    expect(taken).toBe(1);
    expect(report).toHaveBeenCalledWith({
      kind: 'fork',
      groupId: 'g-1',
      epoch: 2,
      peer: 'alice:dev1',
      detail: 'fork',
    });
    expect(recordedIntegrityFindings()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[INTEGRITY] fork in g-1'));
  });

  it('reports one finding once per session, and still records every occurrence', () => {
    const report = vi.fn().mockResolvedValue(undefined);
    setIntegrityFindingReporter(report);
    const finding = {
      kind: 'forged-history' as const,
      groupId: 'g-1',
      peer: 'mallory',
      detail: 'message',
    };
    noteIntegrityFinding(finding, () => {});
    noteIntegrityFinding(finding, () => {});
    expect(report).toHaveBeenCalledTimes(1);
    expect(recordedIntegrityFindings()).toHaveLength(2);
  });

  it('says so when the findings cannot be taken, rather than pretending there were none', async () => {
    const log = vi.fn();
    const taken = await drainForkFindings(
      { takeForkFindings: () => Promise.reject(new Error('gone')) },
      log
    );
    expect(taken).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not take'));
  });
});

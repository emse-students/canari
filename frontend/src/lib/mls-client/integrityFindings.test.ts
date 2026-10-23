import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainForkFindings,
  noteIntegrityFinding,
  recordedIntegrityFindings,
  resetIntegrityFindings,
  setIntegrityFindingReporter,
} from './integrityFindings';

let error: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  error.mockRestore();
  warn.mockRestore();
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
      proven: true,
    });
    expect(recordedIntegrityFindings()).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[INTEGRITY] fork in g-1'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an unproven fork at warn, as mls-core does, and reports it as not proven', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    setIntegrityFindingReporter(report);
    await drainForkFindings(
      {
        takeForkFindings: async () => [
          { kind: 'unproven', groupId: 'g-1', epoch: 2, peer: 'alice:dev1', detail: 'x' },
        ],
      },
      vi.fn()
    );
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[INTEGRITY] fork in g-1'));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ proven: false }));
  });

  it('writes its line in ASCII', () => {
    noteIntegrityFinding({
      kind: 'forged-history',
      groupId: 'g-1234567890',
      peer: 'mallory',
      detail: 'message',
      proven: true,
    });
    const line = String(error.mock.calls[0][0]);
    expect(line).toMatch(/^[\x20-\x7e]*$/);
  });

  it('reports one finding once per session, and still records every occurrence', () => {
    const report = vi.fn().mockResolvedValue(undefined);
    setIntegrityFindingReporter(report);
    const finding = {
      kind: 'forged-history' as const,
      groupId: 'g-1',
      peer: 'mallory',
      detail: 'message',
      proven: true,
    };
    noteIntegrityFinding(finding);
    noteIntegrityFinding(finding);
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

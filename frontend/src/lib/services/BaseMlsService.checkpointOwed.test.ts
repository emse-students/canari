// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const pendingSendGenerations = vi.fn((): unknown[] => []);
vi.mock('$lib/mls-client/sendRatchetLedger', () => ({
  MAX_BURN_GENERATIONS: 2000,
  commitPersisted: vi.fn(),
  noteFrameEmitted: vi.fn(),
  pendingSendGenerations: () => pendingSendGenerations(),
  resetSendRatchetLedger: vi.fn(),
  snapshotEmitted: () => ({}),
}));

const hasPendingHistoryMarks = vi.fn(() => false);
vi.mock('$lib/utils/chat/history', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasPendingHistoryMarks: () => hasPendingHistoryMarks(),
}));

import { BaseMlsService } from './BaseMlsService';

/**
 * `checkpointOwed` answers `owed: false` - the ONLY answer that lets the bulk-ingest end skip its
 * checkpoint - when nothing a checkpoint does would change anything: the manager's state is the one
 * its last landed write holds, the send ledger has nothing to credit, and the replay has no marks to
 * commit. Each of the three is pinned here, because dropping any one of them skips a write that is
 * owed: a ratchet advance lost to a crash, a generation burnt twice, or a frame re-accused as lost.
 */
abstract class OwedHarness extends BaseMlsService {
  stateOwes = false;
  stateAsked = 0;

  constructor() {
    super('web');
  }

  protected async stateOwesCheckpoint(): Promise<boolean> {
    this.stateAsked++;
    return this.stateOwes;
  }
}

/** Concrete only through a cast: the abstract members this seam never reaches are not stubbed. */
const FakeMlsService = OwedHarness as unknown as new () => OwedHarness;

describe('BaseMlsService.checkpointOwed', () => {
  beforeEach(() => {
    pendingSendGenerations.mockReturnValue([]);
    hasPendingHistoryMarks.mockReturnValue(false);
  });

  it('owes nothing when the state, the send ledger and the replay marks all hold nothing new', async () => {
    await expect(new FakeMlsService().checkpointOwed()).resolves.toEqual({
      owed: false,
      by: 'none',
    });
  });

  it('owes a write when the manager holds a state its last landed write does not', async () => {
    const svc = new FakeMlsService();
    svc.stateOwes = true;
    await expect(svc.checkpointOwed()).resolves.toEqual({ owed: true, by: 'state' });
  });

  it('owes a write when the send ledger has frames a checkpoint would credit', async () => {
    pendingSendGenerations.mockReturnValue([{ groupId: 'g', deficit: 1, clamped: false }]);
    const svc = new FakeMlsService();
    await expect(svc.checkpointOwed()).resolves.toEqual({ owed: true, by: 'send-ledger' });
    expect(svc.stateAsked).toBe(0); // local and cheap first, the bridge crossing only if needed
  });

  it('owes a write when the replay has marks a checkpoint would commit', async () => {
    hasPendingHistoryMarks.mockReturnValue(true);
    const svc = new FakeMlsService();
    await expect(svc.checkpointOwed()).resolves.toEqual({ owed: true, by: 'replay-marks' });
  });
});

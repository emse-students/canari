// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import type { BulkIngestObserver, BulkIngestPhase } from '$lib/mls-client/IMlsService';

/**
 * The bulk-ingest observers must be INDEPENDENT of each other.
 *
 * Two subscribe: the encrypted-state persister (registered first, in `setupMessageHandler`) and the
 * UI render buffer (registered later, in `sessionAuth`). They were awaited in one bare loop, so the
 * first to reject cancelled every one after it - and the persister rethrows when a checkpoint fails.
 * The cost was not a lost checkpoint: the UI observer's window stayed OPEN for the rest of the
 * session, which means `messageCatchupDepth` never comes back down (the "Synchronisation des
 * messages..." banner is up forever) and `bulkIngestActive` stays raised, so every later inbound
 * message is buffered instead of rendered and then discarded by the next drain. A failed disk write
 * must cost a checkpoint, never the message pipeline.
 *
 * `beginBulkIngest`/`endBulkIngest` are concrete on the abstract base, so they are exercised on the
 * prototype directly rather than through a subclass that would drag in the whole MLS stack.
 */
type BulkIngestApi = {
  bulkIngestObservers: BulkIngestObserver[];
  openBulkIngests: Map<number, BulkIngestPhase>;
  nextBulkIngestHandle: number;
  beginBulkIngest(phase?: BulkIngestPhase): number;
  endBulkIngest(handle: number): Promise<void>;
};

const PHASE: BulkIngestPhase = { bufferUi: true, showOverlay: true };

/** A bare object wearing the base's two methods - no subclass, no MLS stack. */
function makeHost(observers: BulkIngestObserver[]): BulkIngestApi {
  const proto = BaseMlsService.prototype as unknown as BulkIngestApi;
  return {
    bulkIngestObservers: observers,
    openBulkIngests: new Map(),
    nextBulkIngestHandle: 1,
    beginBulkIngest: proto.beginBulkIngest,
    endBulkIngest: proto.endBulkIngest,
  } as BulkIngestApi;
}

describe('BaseMlsService bulk-ingest observers', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('closes the UI window even when the persister rejects on close', async () => {
    // The exact production shape: persister first (rejects), UI buffer second (must still run).
    const persister: BulkIngestObserver = {
      onBulkIngestStart: vi.fn(),
      onBulkIngestEnd: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    };
    const ui: BulkIngestObserver = {
      onBulkIngestStart: vi.fn(),
      onBulkIngestEnd: vi.fn().mockResolvedValue(undefined),
    };
    const host = makeHost([persister, ui]);

    await host.endBulkIngest(host.beginBulkIngest(PHASE));

    expect(ui.onBulkIngestEnd).toHaveBeenCalledWith(PHASE);
  });

  it('opens the UI window even when the persister throws on open', async () => {
    const persister: BulkIngestObserver = {
      onBulkIngestStart: vi.fn(() => {
        throw new Error('boom');
      }),
      onBulkIngestEnd: vi.fn(),
    };
    const ui: BulkIngestObserver = { onBulkIngestStart: vi.fn(), onBulkIngestEnd: vi.fn() };
    const host = makeHost([persister, ui]);

    host.beginBulkIngest(PHASE);

    expect(ui.onBulkIngestStart).toHaveBeenCalledWith(PHASE);
  });

  it('never swallows the failure silently - it is the only trace a lost checkpoint leaves', async () => {
    const host = makeHost([
      {
        onBulkIngestStart: vi.fn(),
        onBulkIngestEnd: vi.fn().mockRejectedValue(new Error('quota exceeded')),
      },
    ]);

    await host.endBulkIngest(host.beginBulkIngest(PHASE));

    expect(console.error).toHaveBeenCalled();
  });

  it('does not reject, so the drain’s onDrainEnd still ACKs what it processed', async () => {
    const host = makeHost([
      {
        onBulkIngestStart: vi.fn(),
        onBulkIngestEnd: vi.fn().mockRejectedValue(new Error('quota exceeded')),
      },
    ]);

    await expect(host.endBulkIngest(host.beginBulkIngest(PHASE))).resolves.toBeUndefined();
  });

  it('replays the exact phase its matching open used, even after a failure', async () => {
    const persistOnly: BulkIngestPhase = { bufferUi: false, showOverlay: false };
    const ui: BulkIngestObserver = { onBulkIngestStart: vi.fn(), onBulkIngestEnd: vi.fn() };
    const host = makeHost([
      { onBulkIngestStart: vi.fn(), onBulkIngestEnd: vi.fn().mockRejectedValue(new Error('x')) },
      ui,
    ]);

    const outer = host.beginBulkIngest(PHASE);
    const inner = host.beginBulkIngest(persistOnly);
    await host.endBulkIngest(inner);
    await host.endBulkIngest(outer);

    expect(ui.onBulkIngestEnd).toHaveBeenNthCalledWith(1, persistOnly);
    expect(ui.onBulkIngestEnd).toHaveBeenNthCalledWith(2, PHASE);
  });

  /**
   * WINDOWS OVERLAP, THEY DO NOT ONLY NEST - measured on the Mi 9T, 2026-10-12. A drain opened its
   * UI window, a history load opened a persist-only one during the drain, and the drain closed
   * first. Closing "the innermost" replayed the history load's phase for the drain, so the drained
   * message sat in the UI buffer until the history load closed, ~0.6 s later.
   */
  it('closes the window its handle names, when a later one is still open', async () => {
    const persistOnly: BulkIngestPhase = { bufferUi: false, showOverlay: false };
    const ui: BulkIngestObserver = { onBulkIngestStart: vi.fn(), onBulkIngestEnd: vi.fn() };
    const host = makeHost([ui]);

    const drain = host.beginBulkIngest(PHASE);
    const historyLoad = host.beginBulkIngest(persistOnly);
    await host.endBulkIngest(drain);
    expect(ui.onBulkIngestEnd).toHaveBeenNthCalledWith(1, PHASE);

    await host.endBulkIngest(historyLoad);
    expect(ui.onBulkIngestEnd).toHaveBeenNthCalledWith(2, persistOnly);
  });

  it('ignores, and says so, a second close of the same window', async () => {
    const ui: BulkIngestObserver = { onBulkIngestStart: vi.fn(), onBulkIngestEnd: vi.fn() };
    const host = makeHost([ui]);

    const handle = host.beginBulkIngest(PHASE);
    await host.endBulkIngest(handle);
    await host.endBulkIngest(handle);

    expect(ui.onBulkIngestEnd).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not open'));
  });
});

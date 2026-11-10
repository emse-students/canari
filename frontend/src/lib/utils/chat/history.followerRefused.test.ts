// @vitest-environment happy-dom
/**
 * AN ARCHIVE REPLAY ASKED OF A TAB WITHOUT THE LEADER COPY DECRYPTS NOTHING (2026-11-10).
 *
 * The replay moves the ratchet of the copy it runs on and writes the account's shared stream cursor
 * and seen marks. Production `1.6.9` ran it in a follower, whose copy was then checkpointed over the
 * leader's. The restore and the open no longer call it there; this is the last line, for a caller
 * that forgot, and it says so once.
 *
 * Each case loads a FRESH module graph (`vi.resetModules`), so the "said once" flag and the load
 * fact start clean without a test seam - and the cases exercise the behaviour on any build.
 */
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

async function fresh(loadedAsLeader: boolean) {
  vi.resetModules();
  const authority = await import('$lib/mls-client/stateAuthority');
  const history = await import('./history');
  authority.noteMlsStateLoaded(loadedAsLeader);
  return history;
}

function service() {
  return createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    createDecryptSession: vi.fn(),
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });
}

const replay = (history: typeof import('./history'), mlsService: ReturnType<typeof service>) =>
  history.replayConversationHistory({
    mlsService,
    id: 'g-1',
    contactName: 'peer',
    userId: 'u1',
    deviceKey: () => 'k',
    storage: null,
    getConversation: () => undefined,
    setConversation: () => undefined,
    messageReactions: new Map(),
    log: () => undefined,
  });

describe('replayConversationHistory in a tab without the leader copy', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => error.mockRestore());

  it('asks the server for nothing, opens no decrypt session and commits nothing', async () => {
    const history = await fresh(false);
    const mlsService = service();

    await expect(replay(history, mlsService)).resolves.toBeUndefined();

    expect(mlsService.fetchHistory).not.toHaveBeenCalled();
    expect(mlsService.createDecryptSession).not.toHaveBeenCalled();
  });

  it('accuses the caller once, however often it is asked', async () => {
    const history = await fresh(false);
    const mlsService = service();

    await replay(history, mlsService);
    await replay(history, mlsService);

    const accusations = error.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('without the leader copy')
    );
    expect(accusations).toHaveLength(1);
  });

  it('the leader copy still asks the server for the archive', async () => {
    const history = await fresh(true);
    const mlsService = service();

    await replay(history, mlsService);

    expect(mlsService.fetchHistory).toHaveBeenCalled();
  });
});

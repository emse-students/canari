// @vitest-environment happy-dom
/**
 * AN ARCHIVE REPLAY ASKED OF A TAB WITHOUT THE LEADER COPY DECRYPTS NOTHING (2026-11-10).
 *
 * The replay moves the ratchet of the copy it runs on and writes the account's shared stream cursor
 * and seen marks. Production `1.6.9` ran it in a follower, whose copy was then checkpointed over the
 * leader's. The restore and the open no longer call it there; this is the last line, for a caller
 * that forgot, and it says so once.
 */
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { noteMlsStateLoaded, resetStateAuthorityForTests } from '$lib/mls-client/stateAuthority';
import { replayConversationHistory, resetReplayRefusalForTests } from './history';

function service() {
  return createMlsServiceStub({
    getLocalGroups: vi.fn().mockReturnValue(['g-1']),
    createDecryptSession: vi.fn(),
    fetchHistory: vi.fn().mockResolvedValue({ rows: [] }),
  });
}

const replay = (mlsService: ReturnType<typeof service>) =>
  replayConversationHistory({
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
    resetReplayRefusalForTests();
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    error.mockRestore();
    resetStateAuthorityForTests();
  });

  it('asks the server for nothing, opens no decrypt session and commits nothing', async () => {
    noteMlsStateLoaded(false);
    const mlsService = service();

    await expect(replay(mlsService)).resolves.toBeUndefined();

    expect(mlsService.fetchHistory).not.toHaveBeenCalled();
    expect(mlsService.createDecryptSession).not.toHaveBeenCalled();
  });

  it('accuses the caller once, however often it is asked', async () => {
    noteMlsStateLoaded(false);
    const mlsService = service();

    await replay(mlsService);
    await replay(mlsService);

    const accusations = error.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('without the leader copy')
    );
    expect(accusations).toHaveLength(1);
  });

  it('the leader copy still asks the server for the archive', async () => {
    noteMlsStateLoaded(true);
    const mlsService = service();

    await replay(mlsService);

    expect(mlsService.fetchHistory).toHaveBeenCalled();
  });
});

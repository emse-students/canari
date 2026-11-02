/**
 * `keepPendingMutation`'s reports: evictions are COUNTED and said at warn only when a conversation's
 * session total reaches a new power of two - a flood is visible in a handful of lines, never one per
 * put - and an entry the same write evicted is never logged as kept.
 */
import { keepPendingMutation, type PendingMutationDeps } from './pendingMutationStore';
import type { PendingMutationWrite } from '$lib/db/types';

let n = 0;

function deps(writes: PendingMutationWrite[]) {
  const log = vi.fn();
  const storage = {
    putPendingMutation: vi.fn(
      async () => writes.shift() ?? { written: true, kept: true, evicted: 0 }
    ),
    getPendingMutations: vi.fn(async () => ({ entries: [], removedUnreadable: 0 })),
  };
  return {
    log,
    storage,
    deps: {
      storage,
      deviceKey: () => 'key',
      conversations: new Map(),
      messageReactions: new Map(),
      log,
    } as unknown as PendingMutationDeps,
  };
}

const entry = (conversationId: string) => ({
  conversationId,
  messageId: 'm1',
  sender: 'mallory',
  kind: 'delete' as const,
  slot: '',
  rank: 0,
});

afterEach(() => vi.restoreAllMocks());

describe('keepPendingMutation - what it says', () => {
  it('warns at 1, 2, 4, 8... evictions in a conversation, never once per put', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conversation = `flood-${n++}`;
    const { deps: d } = deps(
      Array.from({ length: 9 }, () => ({ written: true, kept: true, evicted: 1 }))
    );

    for (let i = 0; i < 9; i++) await keepPendingMutation(d, entry(conversation), 1_000 + i);

    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said).toHaveLength(4);
    expect(said.map((line) => line.match(/(\d+) evicted this session/)?.[1])).toEqual([
      '1',
      '2',
      '4',
      '8',
    ]);
  });

  it('counts each conversation on its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps: d } = deps([
      { written: true, kept: true, evicted: 1 },
      { written: true, kept: true, evicted: 1 },
    ]);
    await keepPendingMutation(d, entry(`a-${n++}`), 1_000);
    await keepPendingMutation(d, entry(`b-${n++}`), 1_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('never says "kept" of an entry its own write evicted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps: d, log } = deps([{ written: true, kept: false, evicted: 1 }]);

    await keepPendingMutation(d, entry(`self-${n++}`), 1_000);

    const said = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('evicted by the same write');
    expect(said).not.toContain('kept for it');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A NOTICE ROW KEEPS ITS IDS THROUGH A LOAD FROM THE STORE (1.7.0-alpha.1, iPhone and web: "Utilisateur
 * inconnu a ajouté Utilisateur inconnu au groupe" for good, on every device that reloaded the row).
 *
 * The hex-id pass that runs on every stored page replaced each 64-hex id anywhere in a system row's
 * JSON with a display name - the `notice` ids included - so the renderer asked the server for an
 * account named "canari test delta" and drew the unknown label over a correct sentence.
 */
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => NAMES[id] ?? id),
}));

import {
  mkNoticeEnvelope,
  mkSystemEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '$lib/envelope';
import type { IStorage, StoredMessage } from '$lib/db/types';
import type { ChatMessage } from '$lib/types';
import { retroactivelyResolveHexIds } from './history';

const DELTA = 'd'.repeat(64);
const GAMMA = 'a'.repeat(64);
const NAMES: Record<string, string> = {
  [DELTA]: 'Canari Test Delta',
  [GAMMA]: 'Canari Test Gamma',
};

function systemRow(id: string, content: string): ChatMessage {
  return { id, senderId: 'system', content, timestamp: new Date(0), isOwn: false, isSystem: true };
}

/** A store holding `rows`, recording what the pass writes back. */
function storeOf(rows: ChatMessage[]): { storage: IStorage; written: Map<string, string> } {
  const written = new Map<string, string>();
  const storage = {
    mergeMessages: vi.fn(async (_c: string, ids: readonly string[], merge) => {
      for (const id of ids) {
        const row = rows.find((r) => r.id === id)!;
        const next = merge({
          id,
          conversationId: 'g1',
          senderId: 'system',
          content: row.content,
          timestamp: 0,
        } as StoredMessage);
        if (next) written.set(id, next.content);
      }
      return new Set(ids);
    }),
  } as unknown as IStorage;
  return { storage, written };
}

beforeEach(() => vi.clearAllMocks());

describe('the hex-id pass never touches the ids a notice carries', () => {
  it('leaves a notice row whose sentence names everyone exactly as it was', async () => {
    const spec = { event: 'memberAdded' as const, actor: DELTA, targets: [GAMMA] };
    const row = systemRow(
      'n1',
      serializeEnvelope(
        mkNoticeEnvelope('Canari Test Delta a ajouté Canari Test Gamma au groupe', spec)
      )
    );
    const { storage, written } = storeOf([row]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [out] = await retroactivelyResolveHexIds([row], storage, 'g1', 'k');

    expect(out).toBe(row);
    const envelope = parseEnvelope(out.content);
    expect(envelope.kind === 'system' && envelope.notice).toEqual(spec);
    expect(written.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // The server still holds legacy ids that are not 64 hex, and an upper-case hex id is an id too:
  // neither is evidence of the old damage, and a valid id dropped would be lost for good.
  it.each([
    ['a legacy id that is not hex', 'svc-review_1'],
    ['an upper-case hex id', DELTA.toUpperCase()],
  ])('keeps a notice whose actor is %s, unwritten', async (_what, actor) => {
    const spec = { event: 'memberAdded' as const, actor, targets: [GAMMA] };
    const row = systemRow(
      'n5',
      serializeEnvelope(mkNoticeEnvelope('Revue a ajouté Canari Test Gamma au groupe', spec))
    );
    const { storage, written } = storeOf([row]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [out] = await retroactivelyResolveHexIds([row], storage, 'g1', 'k');

    expect(out).toBe(row);
    expect(written.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('names the ids of the sentence and keeps the notice ids', async () => {
    // Written while both lookups failed: the sentence holds the ids, for a later reader to name.
    const spec = { event: 'memberAdded' as const, actor: DELTA, targets: [GAMMA] };
    const row = systemRow(
      'n2',
      serializeEnvelope(mkNoticeEnvelope(`${DELTA} a ajouté ${GAMMA} au groupe`, spec))
    );
    const { storage, written } = storeOf([row]);

    const [out] = await retroactivelyResolveHexIds([row], storage, 'g1', 'k');

    const envelope = parseEnvelope(out.content);
    expect(envelope.kind).toBe('system');
    if (envelope.kind !== 'system') return;
    expect(envelope.text).toBe('Canari Test Delta a ajouté Canari Test Gamma au groupe');
    expect(envelope.notice).toEqual(spec);
    expect(parseEnvelope(written.get('n2')!)).toEqual(envelope);
  });

  it('still names a legacy plain-sentence row', async () => {
    const row = systemRow('n3', serializeEnvelope(mkSystemEnvelope(`${DELTA} a quitté le groupe`)));
    const [out] = await retroactivelyResolveHexIds([row], null, 'g1', 'k');
    expect(parseEnvelope(out.content)).toEqual({
      kind: 'system',
      text: 'Canari Test Delta a quitté le groupe',
    });
  });

  it('repairs a notice an earlier pass emptied of its ids: the sentence stands, the notice goes', async () => {
    // What the 1.7.0-alpha.1 store holds: the ids replaced by the names the sentence already had.
    const content = JSON.stringify({
      kind: 'system',
      text: 'Canari Test Delta a ajouté Canari Test Gamma au groupe',
      notice: { event: 'memberAdded', actor: 'Canari Test Delta', targets: ['Canari Test Gamma'] },
    });
    const row = systemRow('n4', content);
    const { storage, written } = storeOf([row]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [out] = await retroactivelyResolveHexIds([row], storage, 'g1', 'k');

    expect(parseEnvelope(out.content)).toEqual({
      kind: 'system',
      text: 'Canari Test Delta a ajouté Canari Test Gamma au groupe',
    });
    // Persisted, so the repair is said once per row and never asked of the server again.
    expect(written.get('n4')).toBe(out.content);
    expect(warn).toHaveBeenCalledTimes(1);

    // The next load reads what was written: nothing left to repair, nothing said, nothing written.
    const reloaded = systemRow('n4', written.get('n4')!);
    const again = storeOf([reloaded]);
    const [second] = await retroactivelyResolveHexIds([reloaded], again.storage, 'g1', 'k');
    expect(second).toBe(reloaded);
    expect(again.written.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

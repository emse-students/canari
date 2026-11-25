/**
 * `moveMessageRows` against an in-memory store whose rows a test can delete or seal between two of
 * the move's steps: a row not united is sent back through `rekeyAbsent` once, so a destination
 * deleted since the re-key ends MOVED (and no warning says a side does not open), while a side that
 * really does not open ends KEPT after that one retry.
 */
import { moveMessageRows, type MovableRowStore } from './messageMove';
import type { RevisedRow } from './messageCas';
import type { StoredMessage } from './types';

const A = 'conversation-a';
const B = 'conversation-b';

interface Cell {
  msg: StoredMessage;
  rev: number;
  sealed?: boolean;
}

/** One map keyed `conversation/id`; a `sealed` cell is one this device cannot open. */
function memoryStore(hooks: { afterRekey?: (round: number) => void } = {}) {
  const cells = new Map<string, Cell>();
  const key = (c: string, id: string) => `${c}/${id}`;
  let rekeys = 0;
  const store: MovableRowStore = {
    async rekeyAbsent(from, to, ids) {
      const moved: string[] = [];
      const collided: string[] = [];
      for (const id of ids) {
        const cell = cells.get(key(from, id));
        if (!cell) continue;
        if (cells.has(key(to, id))) {
          collided.push(id);
          continue;
        }
        cells.delete(key(from, id));
        cells.set(key(to, id), {
          ...cell,
          msg: { ...cell.msg, conversationId: to },
          rev: cell.rev + 1,
        });
        moved.push(id);
      }
      hooks.afterRekey?.(++rekeys);
      return { moved, collided };
    },
    async read(conversationId, ids) {
      const rows = new Map<string, RevisedRow>();
      for (const id of ids) {
        const cell = cells.get(key(conversationId, id));
        if (cell && !cell.sealed) rows.set(id, { msg: cell.msg, rev: cell.rev, stamp: 'iv' });
      }
      return { rows };
    },
    async writeIfUnchanged(conversationId, writes) {
      const ok = new Set<string>();
      for (const w of writes) {
        const cell = cells.get(key(conversationId, w.msg.id));
        if (!cell || cell.rev !== w.rev) continue;
        cells.set(key(conversationId, w.msg.id), { msg: w.msg, rev: cell.rev + 1 });
        ok.add(w.msg.id);
      }
      return ok;
    },
    async deleteIfUnchanged(conversationId, rows) {
      const deleted = new Set<string>();
      for (const { id, rev } of rows) {
        const cell = cells.get(key(conversationId, id));
        if (!cell || cell.rev !== rev) continue;
        cells.delete(key(conversationId, id));
        deleted.add(id);
      }
      return deleted;
    },
  };
  const put = (c: string, content: string, sealed = false) =>
    cells.set(key(c, 'm'), {
      msg: { id: 'm', conversationId: c, senderId: 'alice', content, timestamp: 1 },
      rev: 0,
      sealed,
    });
  return { store, cells, key, put };
}

afterEach(() => vi.restoreAllMocks());

describe('moveMessageRows - a row not united', () => {
  it('a destination deleted between the re-key and the unite is retried, and the source MOVES', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rig = memoryStore({
      // Round one saw the destination's row; it is deleted before the unite reads it.
      afterRekey: (round) => {
        if (round === 1) rig.cells.delete(rig.key(B, 'm'));
      },
    });
    rig.put(A, 'the source');
    rig.put(B, 'the destination');

    const move = await moveMessageRows(rig.store, A, B, ['m'], 'k');

    expect(move).toEqual({ moved: ['m'], alreadyThere: [], kept: [] });
    expect(rig.cells.has(rig.key(A, 'm'))).toBe(false);
    expect(rig.cells.get(rig.key(B, 'm'))?.msg.content).toBe('the source');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a source deleted between the re-key and the unite leaves nothing to move, and no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rig = memoryStore({
      afterRekey: (round) => {
        if (round === 1) rig.cells.delete(rig.key(A, 'm'));
      },
    });
    rig.put(A, 'the source');
    rig.put(B, 'the destination');

    expect(await moveMessageRows(rig.store, A, B, ['m'], 'k')).toEqual({
      moved: [],
      alreadyThere: [],
      kept: [],
    });
    expect(rig.cells.get(rig.key(B, 'm'))?.msg.content).toBe('the destination');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a destination that does not open is KEPT after one retry, and the warning names that side', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rig = memoryStore();
    rig.put(A, 'the source');
    rig.put(B, 'sealed', true);

    expect(await moveMessageRows(rig.store, A, B, ['m'], 'k')).toEqual({
      moved: [],
      alreadyThere: [],
      kept: ['m'],
    });
    expect(rig.cells.get(rig.key(A, 'm'))?.msg.content).toBe('the source');
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('(0 source, 1 destination)');
  });
});

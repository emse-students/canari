// @vitest-environment happy-dom
/**
 * THE UNSENT LEDGER IS SHARED BY EVERY TAB, SO A TEXT COMES BACK ONLY WHEN ITS WRITER IS PROVEN DEAD.
 *
 * A sibling tab opening the same salon used to take, and hand back to its own composer, a text the
 * first tab was still sending. The proof of death is the writer's Web Lock: the browser releases it
 * with the document, so a fake lock manager whose held set we control stands in for the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SALON = 'channel_c1';
const OWNER_LOCK_PREFIX = 'canari.salon-unsent.owner.';

/** A lock manager whose held locks are a set the test can empty, as a closed tab would. */
function fakeLocks() {
  const held = new Set<string>();
  const manager = {
    request: vi.fn((name: string) => {
      held.add(name);
      return new Promise<never>(() => {});
    }),
    query: vi.fn(async () => ({ held: [...held].map((name) => ({ name })), pending: [] })),
  };
  return { held, manager };
}

function installLocks(manager: unknown): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: manager });
}

/** An entry written by ANOTHER page life, straight into the shared store. */
function writeForeign(owner: string | undefined, messageId: string): void {
  const key = 'canari.salon-unsent.me';
  const all = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
  all.push({ messageId, conversationKey: SALON, text: `text ${messageId}`, owner });
  localStorage.setItem(key, JSON.stringify(all));
}

async function load() {
  vi.resetModules();
  return import('./salonUnsent');
}

describe('the unsent ledger across tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    installLocks(undefined);
    vi.restoreAllMocks();
  });

  it('a record claims this page life its owner lock, once', async () => {
    const { held, manager } = fakeLocks();
    installLocks(manager);
    const ledger = await load();

    ledger.recordUnsentSalonText('me', { messageId: 'a', conversationKey: SALON, text: 'a' });
    ledger.recordUnsentSalonText('me', { messageId: 'b', conversationKey: SALON, text: 'b' });

    expect(manager.request).toHaveBeenCalledTimes(1);
    expect([...held]).toEqual([`${OWNER_LOCK_PREFIX}${ledger.SALON_UNSENT_PAGE_LIFE}`]);
  });

  it('a sibling tab whose owner lock is held keeps its text; once released, the text comes back', async () => {
    const { held, manager } = fakeLocks();
    installLocks(manager);
    held.add(`${OWNER_LOCK_PREFIX}sibling`);
    writeForeign('sibling', 'm1');
    const ledger = await load();

    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set())).toHaveLength(0);

    held.delete(`${OWNER_LOCK_PREFIX}sibling`); // the sibling tab closed
    const taken = await ledger.takeOrphanedSalonTexts('me', SALON, new Set());
    expect(taken.map((e) => e.messageId)).toEqual(['m1']);
    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set())).toHaveLength(0);
  });

  it('an entry written while the locks are queried is never taken: its writer was not in the snapshot', async () => {
    const { held, manager } = fakeLocks();
    installLocks(manager);
    const ledger = await load();
    // During the query a sibling tab opens and records (its lock lands after the snapshot), and this
    // life's own send leaves - absent from the `live` set the caller computed before.
    manager.query.mockImplementationOnce(async () => {
      const snapshot = { held: [...held].map((name) => ({ name })), pending: [] };
      held.add(`${OWNER_LOCK_PREFIX}newcomer`);
      writeForeign('newcomer', 'theirs');
      ledger.recordUnsentSalonText('me', { messageId: 'mine', conversationKey: SALON, text: 'x' });
      return snapshot;
    });

    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set())).toHaveLength(0);
    const kept = JSON.parse(localStorage.getItem('canari.salon-unsent.me') ?? '[]') as {
      messageId: string;
    }[];
    expect(kept.map((e) => e.messageId).sort()).toEqual(['mine', 'theirs']);
  });

  it('an entry its owner cleared while the locks were queried does not come back', async () => {
    const { manager } = fakeLocks();
    installLocks(manager);
    writeForeign('dead', 'answered');
    const ledger = await load();
    manager.query.mockImplementationOnce(async () => {
      ledger.clearUnsentSalonText('me', 'answered');
      return { held: [], pending: [] };
    });

    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set())).toHaveLength(0);
  });

  it("this page life's own entry comes back only when no live send owns it", async () => {
    const { manager } = fakeLocks();
    installLocks(manager);
    const ledger = await load();
    ledger.recordUnsentSalonText('me', { messageId: 'mine', conversationKey: SALON, text: 'x' });

    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set(['mine']))).toHaveLength(0);
    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set())).toHaveLength(1);
  });

  it('an entry written before owners existed has nobody to wait for and comes back', async () => {
    const { manager } = fakeLocks();
    installLocks(manager);
    writeForeign(undefined, 'legacy');
    const ledger = await load();

    expect(await ledger.takeOrphanedSalonTexts('me', SALON, new Set())).toHaveLength(1);
  });

  it('without Web Locks a foreign entry is never taken, and that is said', async () => {
    installLocks(undefined);
    writeForeign('sibling', 'm1');
    const ledger = await load();
    ledger.recordUnsentSalonText('me', { messageId: 'mine', conversationKey: SALON, text: 'x' });

    const taken = await ledger.takeOrphanedSalonTexts('me', SALON, new Set());

    expect(taken.map((e) => e.messageId)).toEqual(['mine']);
    expect(
      vi.mocked(console.warn).mock.calls.some(([l]) => String(l).includes('no Web Locks'))
    ).toBe(true);
  });
});

// @vitest-environment happy-dom
import {
  REGISTER_ASKS_MAX,
  REGISTER_OWED_LIMIT,
  clearRegisterOwed,
  isRegisterOwed,
  noteRegisterAsked,
  noteRegisterOwed,
} from './registerOwed';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * The durable "register owed" marker (docs/wiki/protocols/history-answer-addressing.md, "The
 * newcomer asks for its register"): written at the admission, read by every reconciliation of the
 * group, cleared by the first accepted state. It must survive a reload and hold per account.
 */
describe('registerOwed - the state a newcomer still asks for', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('is owed from the admission until the state arrives', () => {
    expect(isRegisterOwed('ann', 'g1')).toBe(false);
    noteRegisterOwed('ann', 'g1');
    expect(isRegisterOwed('ann', 'g1')).toBe(true);
    clearRegisterOwed('ann', 'g1', 'register answer');
    expect(isRegisterOwed('ann', 'g1')).toBe(false);
  });

  it('is DURABLE - read back from storage, as a reloaded page reads it', () => {
    noteRegisterOwed('ann', 'g1');
    expect(JSON.parse(localStorage.getItem(ACCOUNT_KEY.registerOwed('ann')) ?? '[]')).toEqual([
      { group: 'g1', asked: 0 },
    ]);
  });

  it('is per account, and an account id compares case-insensitively', () => {
    noteRegisterOwed('Ann', 'g1');
    expect(isRegisterOwed('ann', 'g1')).toBe(true);
    expect(isRegisterOwed('bob', 'g1')).toBe(false);
  });

  it('a second admission to the same group is one entry, cleared once', () => {
    noteRegisterOwed('ann', 'g1');
    noteRegisterOwed('ann', 'g1');
    clearRegisterOwed('ann', 'g1', 'join push');
    expect(isRegisterOwed('ann', 'g1')).toBe(false);
  });

  it('is bounded: the OLDEST group is pushed out, never the newest', () => {
    for (let i = 0; i <= REGISTER_OWED_LIMIT; i++) noteRegisterOwed('ann', `g${i}`);
    expect(isRegisterOwed('ann', 'g0')).toBe(false);
    expect(isRegisterOwed('ann', 'g1')).toBe(true);
    expect(isRegisterOwed('ann', `g${REGISTER_OWED_LIMIT}`)).toBe(true);
  });

  it('an unreadable list reads as nothing owed, and says so at error', () => {
    localStorage.setItem(ACCOUNT_KEY.registerOwed('ann'), '{not json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(isRegisterOwed('ann', 'g1')).toBe(false);
    expect(error.mock.calls.join(' ')).toContain('owed register list unreadable');
  });

  it('clearing a group that owes nothing writes nothing and says nothing', () => {
    const log = vi.spyOn(console, 'log');
    clearRegisterOwed('ann', 'g1', 'join push');
    expect(localStorage.getItem(ACCOUNT_KEY.registerOwed('ann'))).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  /**
   * IT TERMINATES ON A COUNT OF ASKS, durably: a group whose members never answer `register` (an
   * older build, a server that cannot address) stops being asked after REGISTER_ASKS_MAX asks.
   */
  it('ends after REGISTER_ASKS_MAX asks that took nothing, said at warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRegisterOwed('ann', 'g1');
    for (let i = 1; i < REGISTER_ASKS_MAX; i++) noteRegisterAsked('ann', 'g1');
    expect(isRegisterOwed('ann', 'g1')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    noteRegisterAsked('ann', 'g1');
    expect(isRegisterOwed('ann', 'g1')).toBe(false);
    expect(warn.mock.calls.join(' ')).toContain(
      `asked for its register ${REGISTER_ASKS_MAX} time(s)`
    );
  });

  it('counts across a reload - the count is stored, not held in memory', () => {
    noteRegisterOwed('ann', 'g1');
    noteRegisterAsked('ann', 'g1');
    noteRegisterAsked('ann', 'g1');
    expect(JSON.parse(localStorage.getItem(ACCOUNT_KEY.registerOwed('ann')) ?? '[]')).toEqual([
      { group: 'g1', asked: 2 },
    ]);
  });

  it('a new admission to the group asks from zero again', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRegisterOwed('ann', 'g1');
    for (let i = 1; i < REGISTER_ASKS_MAX; i++) noteRegisterAsked('ann', 'g1');
    noteRegisterOwed('ann', 'g1');
    noteRegisterAsked('ann', 'g1');
    expect(isRegisterOwed('ann', 'g1')).toBe(true);
  });

  it('counting a group that owes nothing writes nothing', () => {
    noteRegisterAsked('ann', 'g1');
    expect(localStorage.getItem(ACCOUNT_KEY.registerOwed('ann'))).toBeNull();
  });
});

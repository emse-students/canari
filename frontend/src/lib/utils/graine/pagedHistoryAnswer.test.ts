import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_KEY } from '../accountLocalKeys';
import {
  forgetPagedHistoryAnswer,
  incompleteHistoryPages,
  noteHistoryAsked,
  noteHistoryPage,
} from './pagedHistoryAnswer';

/** Whether the answer to our history ask arrived whole (channel-encryption section 4.4). */
describe('pagedHistoryAnswer', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('names the pages that never came of an answer that arrived in part', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 2, 4);
    noteHistoryPage('alice', 'ws-1', 'r-1', 0, 4);

    expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1, 3]);
  });

  it('closes the record on the last page, in any order, a duplicate included', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    for (const page of [2, 0, 0, 1]) noteHistoryPage('alice', 'ws-1', 'r-1', page, 3);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.pagedHistoryAnswer('alice'))).toBeNull();
  });

  it('closes the record on an answer of one message', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 0, 0);

    expect(localStorage.getItem(ACCOUNT_KEY.pagedHistoryAnswer('alice'))).toBeNull();
  });

  it('owes nothing for an ask nobody answered - that is the ordinary re-ask, not this one', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });

  it('ignores a page of any request but our history ask', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-repair', 0, 3);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });

  it('owes the re-ask ONCE: a second incomplete answer is left to the per-session repair', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 0, 2);
    expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1]);

    noteHistoryAsked('alice', 'ws-1', 'r-2', true);
    noteHistoryPage('alice', 'ws-1', 'r-2', 1, 2);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });

  it('puts the record back when the ask that replaced it was never sent - the re-ask is not spent', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 0, 2);

    const undo = noteHistoryAsked('alice', 'ws-1', 'r-2', true);
    undo();

    expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1]);
  });

  it('forgets a community that left this device', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 0, 2);
    forgetPagedHistoryAnswer('alice', 'ws-1');

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });
});

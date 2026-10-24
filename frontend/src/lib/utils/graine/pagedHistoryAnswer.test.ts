// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAINE_BUNDLE_MAX_PAGES } from '$lib/crypto/graineConstants';
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
    noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 2, 4);
    noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 4);

    expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1, 3]);
  });

  it('closes the record on the last page, in any order, a duplicate included', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    for (const page of [2, 0, 0, 1]) noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', page, 3);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
    expect(localStorage.getItem(ACCOUNT_KEY.pagedHistoryAnswer('alice'))).toBeNull();
  });

  it('closes the record on an answer of one message', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 0);

    expect(localStorage.getItem(ACCOUNT_KEY.pagedHistoryAnswer('alice'))).toBeNull();
  });

  it('owes nothing for an ask nobody answered - that is the ordinary re-ask, not this one', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });

  it('ignores a page of any request but our history ask', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-repair', 'bob', 0, 3);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });

  it('owes the re-ask ONCE: a second incomplete answer is left to the per-session repair', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 2);
    expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1]);

    noteHistoryAsked('alice', 'ws-1', 'r-2', true);
    noteHistoryPage('alice', 'ws-1', 'r-2', 'bob', 1, 2);

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });

  it('puts the record back when the ask that replaced it was never sent - the re-ask is not spent', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 2);

    const undo = noteHistoryAsked('alice', 'ws-1', 'r-2', true);
    undo();

    expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1]);
  });

  describe('the page numbers come off the wire from any member, so they are refused, never trusted', () => {
    function stored(): Record<string, { received: number[]; pageCount: number }> {
      return JSON.parse(localStorage.getItem(ACCOUNT_KEY.pagedHistoryAnswer('alice')) ?? '{}');
    }

    beforeEach(() => {
      vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('does not record a page whose index is outside its count', () => {
      noteHistoryAsked('alice', 'ws-1', 'r-1', false);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 3);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 7, 3);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', -1, 3);

      expect(stored()['ws-1'].received).toEqual([0]);
      expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1, 2]);
    });

    it('does not record a count above the most pages any answer can fill - nor allocate by it', () => {
      noteHistoryAsked('alice', 'ws-1', 'r-1', false);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, GRAINE_BUNDLE_MAX_PAGES + 1);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 0xffffffff);

      expect(stored()['ws-1'].pageCount).toBe(0);
      expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
    });

    it('reads a stored count above the cap as no record, rather than walking it at every start', () => {
      localStorage.setItem(
        ACCOUNT_KEY.pagedHistoryAnswer('alice'),
        JSON.stringify({
          'ws-1': {
            requestId: 'r-1',
            sender: 'bob',
            pageCount: 0xffffffff,
            received: [0],
            reasked: false,
          },
        })
      );

      expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
    });

    it('refuses a page that disagrees with the count already recorded', () => {
      noteHistoryAsked('alice', 'ws-1', 'r-1', false);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 3);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 1, 2);

      expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1, 2]);
    });

    it('refuses a page of the same request from a second sender', () => {
      noteHistoryAsked('alice', 'ws-1', 'r-1', false);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 3);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'mallory', 1, 3);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'mallory', 2, 3);

      expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1, 2]);
    });

    it('cannot be closed early by a forged "page 1 of 1" or "one message" - the re-ask stays owed', () => {
      noteHistoryAsked('alice', 'ws-1', 'r-1', false);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 3);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'mallory', 0, 1);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'mallory', 0, 0);
      noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 1);

      expect(incompleteHistoryPages('alice', 'ws-1')).toEqual([1, 2]);
    });
  });

  it('forgets a community that left this device', () => {
    noteHistoryAsked('alice', 'ws-1', 'r-1', false);
    noteHistoryPage('alice', 'ws-1', 'r-1', 'bob', 0, 2);
    forgetPagedHistoryAnswer('alice', 'ws-1');

    expect(incompleteHistoryPages('alice', 'ws-1')).toBeNull();
  });
});

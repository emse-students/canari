import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyOwnUninvitedEntry,
  reportOwnUninvitedEntry,
  resetReportedUninvitedEntries,
  setUninvitedEntryReporter,
} from './uninvitedEntry';
import { parseExternalJoinStanding } from './externalJoinStanding';

// Slice 1 of the admission fix-forward (docs/wiki/protocols/admission-fix-forward.md): the entrant's
// own word for an entry no member made, classified from the facts it decided the join on.

describe('classifyOwnUninvitedEntry', () => {
  it('names a 1:1 by the conversation, whatever the seat', () => {
    expect(classifyOwnUninvitedEntry(false, 'unhonoured-seat')).toBe('entrant-direct-peer');
    expect(classifyOwnUninvitedEntry(false, 'not-pending')).toBe('entrant-direct-peer');
    expect(classifyOwnUninvitedEntry(false, 'no-device-row')).toBe('entrant-direct-peer');
  });

  it('names a group entry by the seat reading that opened the door', () => {
    expect(classifyOwnUninvitedEntry(true, 'unhonoured-seat')).toBe('entrant-unhonoured-seat');
    expect(classifyOwnUninvitedEntry(true, 'not-pending')).toBe('entrant-not-pending');
    expect(classifyOwnUninvitedEntry(true, 'no-device-row')).toBe('entrant-no-device-row');
  });
});

describe('reportOwnUninvitedEntry', () => {
  const sent = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    sent.mockClear();
    resetReportedUninvitedEntries();
    setUninvitedEntryReporter(sent);
  });
  afterEach(() => {
    setUninvitedEntryReporter(null);
    vi.restoreAllMocks();
  });

  it('sends the entry under the key its members report it by, with no key fingerprint', () => {
    reportOwnUninvitedEntry('g1', 'bob:dev2', 7, 'entrant-no-device-row');
    expect(sent).toHaveBeenCalledWith({
      kind: 'entrant-no-device-row',
      groupId: 'g1',
      entrant: 'bob:dev2',
      epoch: 7,
    });
  });

  it('sends one entry once per session, and a later entry again', () => {
    reportOwnUninvitedEntry('g1', 'bob:dev2', 7, 'entrant-unhonoured-seat');
    reportOwnUninvitedEntry('g1', 'bob:dev2', 7, 'entrant-unhonoured-seat');
    reportOwnUninvitedEntry('g1', 'bob:dev2', 9, 'entrant-unhonoured-seat');
    expect(sent).toHaveBeenCalledTimes(2);
  });
});

describe('parseExternalJoinStanding', () => {
  it('takes the three words the engine says', () => {
    expect(parseExternalJoinStanding('own-leaf')).toBe('own-leaf');
    expect(parseExternalJoinStanding('further-device')).toBe('further-device');
    expect(parseExternalJoinStanding('no-leaf-of-user')).toBe('no-leaf-of-user');
  });

  it('throws on a word from a binding that does not match this client', () => {
    expect(() => parseExternalJoinStanding(true)).toThrow(/unknown external-join standing/);
    expect(() => parseExternalJoinStanding('member')).toThrow(/unknown external-join standing/);
  });
});

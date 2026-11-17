import { describe, expect, it } from 'vitest';
import {
  boundedRestatedGroupName,
  groupNameSupersedes,
  parseDatedGroupName,
  restatedGroupName,
  withDatedGroupName,
} from './groupName';
import type { Conversation } from '$lib/types';

const T = Date.UTC(2026, 10, 17, 9, 0, 0);

function group(extra: Partial<Conversation> = {}): Conversation {
  return {
    id: 'g1',
    contactName: 'g1',
    name: 'Groupe',
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
    ...extra,
  };
}

describe('a group name is ordered by the server time of the frame that stated it', () => {
  it('any dated statement beats an undated name (one from the server list)', () => {
    expect(groupNameSupersedes({ name: 'A', at: T }, { name: 'Groupe' })).toBe(true);
  });

  it('the later statement wins, whatever order it is read in', () => {
    const older = { name: 'Old', at: T };
    const newer = { name: 'New', at: T + 1000 };
    const afterNewer = withDatedGroupName(group(), newer)!;
    expect(withDatedGroupName(afterNewer, older)).toBeNull();
    const afterOlder = withDatedGroupName(group(), older)!;
    expect(withDatedGroupName(afterOlder, newer)?.name).toBe('New');
  });

  it('a tie is settled by the larger name, so two devices agree from either arrival order', () => {
    const a = { name: 'Alpha', at: T };
    const b = { name: 'Beta', at: T };
    const viaA = withDatedGroupName(withDatedGroupName(group(), a)!, b) ?? group();
    const viaB = withDatedGroupName(group(), b)!;
    expect(viaA.name).toBe('Beta');
    expect(withDatedGroupName(viaB, a)).toBeNull();
  });

  it('a restatement of the name already held changes nothing', () => {
    const held = withDatedGroupName(group(), { name: 'Same', at: T })!;
    expect(withDatedGroupName(held, { name: 'Same', at: T })).toBeNull();
  });

  it('only a group row takes one: a DM and a channel keep their own names', () => {
    expect(
      withDatedGroupName(group({ conversationType: 'direct' }), { name: 'X', at: T })
    ).toBeNull();
    expect(
      withDatedGroupName(group({ conversationType: 'channel' }), { name: 'X', at: T })
    ).toBeNull();
  });

  it('writes the date beside the name', () => {
    expect(withDatedGroupName(group(), { name: 'Les ROOTz', at: T })).toMatchObject({
      name: 'Les ROOTz',
      nameAt: T,
    });
  });
});

describe('what is read off the wire', () => {
  it('refuses an empty name and a time that is not a positive number', () => {
    expect(parseDatedGroupName('  ', T)).toBeNull();
    expect(parseDatedGroupName(42, T)).toBeNull();
    expect(parseDatedGroupName('A', undefined)).toBeNull();
    expect(parseDatedGroupName('A', 0)).toBeNull();
    expect(parseDatedGroupName('A', Number.NaN)).toBeNull();
    expect(parseDatedGroupName(' A ', T)).toEqual({ name: 'A', at: T });
  });

  it('a join push restates only a name a frame dated', () => {
    expect(restatedGroupName({ name: 'Groupe' })).toBeUndefined();
    expect(restatedGroupName({ name: 'Groupe', nameAt: T })).toEqual({ name: 'Groupe', at: T });
  });

  it('a restated date later than the push carrying it was not the server`s, and is refused', () => {
    expect(boundedRestatedGroupName({ name: 'A', at: T }, T)).toEqual({
      kept: { name: 'A', at: T },
    });
    expect(boundedRestatedGroupName({ name: 'A', at: T + 1 }, T)).toHaveProperty('refused');
    expect(boundedRestatedGroupName({ name: 'A', at: T }, undefined)).toHaveProperty('refused');
    expect(boundedRestatedGroupName('A', T)).toHaveProperty('refused');
  });
});

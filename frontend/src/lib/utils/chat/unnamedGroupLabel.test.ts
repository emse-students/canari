/**
 * An UNNAMED group is drawn by its members' first names, and every member's device draws the same
 * label from the same tree (docs/wiki/frontend/modules/chat.md#one-new-discussion-panel).
 */
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { composeUnnamedGroupLabel, memberUserIdsOfTree } from './unnamedGroupLabel';

const FIRST: Record<string, string> = {
  alice: 'Alice',
  bob: 'Bob',
  chloe: 'Chloé',
  david: 'David',
  emma: 'Emma',
  me: 'Moi',
};
const firstNameOf = (id: string) => FIRST[id] ?? id;

describe('memberUserIdsOfTree', () => {
  it('reads one user per person, whatever their number of devices, in canonical form', () => {
    expect(memberUserIdsOfTree(['Bob:d1', 'alice:d2', 'bob:d3', 'alice:d4'])).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('drops a leaf that names nobody', () => {
    expect(memberUserIdsOfTree(['a:b:c', ':d1', 'alice:d1'])).toEqual(['alice']);
  });
});

describe('composeUnnamedGroupLabel', () => {
  it('names the OTHER members, never the viewer', () => {
    expect(composeUnnamedGroupLabel(['me', 'alice', 'bob'], 'me', firstNameOf)).toBe(
      m.group_default_name_two({ first: 'Alice', second: 'Bob' })
    );
  });

  it('is the same on every member device: the order is the first names, not the tree', () => {
    const a = composeUnnamedGroupLabel(['chloe', 'alice', 'bob'], 'me', firstNameOf);
    const b = composeUnnamedGroupLabel(['bob', 'chloe', 'alice'], 'me', firstNameOf);
    expect(a).toBe(b);
    expect(a).toBe(m.group_default_name_three({ first: 'Alice', second: 'Bob', third: 'Chloé' }));
  });

  it('names two and counts the rest past three, so the count is never one', () => {
    expect(composeUnnamedGroupLabel(['alice', 'bob', 'chloe', 'david'], 'me', firstNameOf)).toBe(
      m.group_default_name_more({ first: 'Alice', second: 'Bob', count: 2 })
    );
  });

  it('says how many more there are past three', () => {
    expect(
      composeUnnamedGroupLabel(['alice', 'bob', 'chloe', 'david', 'emma'], 'me', firstNameOf)
    ).toBe(m.group_default_name_more({ first: 'Alice', second: 'Bob', count: 3 }));
  });

  it('names one other member by their first name alone', () => {
    expect(composeUnnamedGroupLabel(['me', 'alice'], 'me', firstNameOf)).toBe('Alice');
  });

  it('has nothing to say when the viewer is alone, so the caller keeps its own word', () => {
    expect(composeUnnamedGroupLabel(['me'], 'me', firstNameOf)).toBeNull();
    expect(composeUnnamedGroupLabel([], 'me', firstNameOf)).toBeNull();
  });

  it('compares the viewer canonically', () => {
    expect(composeUnnamedGroupLabel(['me', 'alice'], 'ME', firstNameOf)).toBe('Alice');
  });
});

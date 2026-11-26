import { describe, it, expect } from 'vitest';
import {
  eventLinkableBy,
  linkableEventsForAuthor,
  unlinkableSelection,
  type LinkableEvent,
} from './postEventLink';

const own: LinkableEvent = { id: 'own', associationId: 'A', coOwners: [] };
const coOrganised: LinkableEvent = {
  id: 'co',
  associationId: 'B',
  coOwners: [{ associationId: 'A' }],
};
const foreign: LinkableEvent = { id: 'foreign', associationId: 'B', coOwners: [] };
const all = [own, coOrganised, foreign];

describe('which events an author may link', () => {
  it('is the event it organises or one it co-organises, and no other', () => {
    expect(eventLinkableBy(own, 'A')).toBe(true);
    expect(eventLinkableBy(coOrganised, 'A')).toBe(true);
    expect(eventLinkableBy(foreign, 'A')).toBe(false);
  });

  it("the picker offers nothing of another association's", () => {
    expect(linkableEventsForAuthor(all, 'A').map((e) => e.id)).toEqual(['own', 'co']);
    expect(linkableEventsForAuthor(all, 'B').map((e) => e.id)).toEqual(['co', 'foreign']);
  });

  it('offers nothing without an association author, and keeps the event a post already carries', () => {
    expect(linkableEventsForAuthor(all, null)).toEqual([]);
    expect(linkableEventsForAuthor(all, 'A', 'foreign').map((e) => e.id)).toEqual([
      'own',
      'co',
      'foreign',
    ]);
  });

  it('flags a selection the current author cannot link, as a known fact', () => {
    expect(unlinkableSelection(all, 'foreign', 'A')).toBe(foreign);
    expect(unlinkableSelection(all, 'co', 'A')).toBeNull();
    expect(unlinkableSelection(all, '', 'A')).toBeNull();
    expect(unlinkableSelection(all, 'unknown', 'A')).toBeNull();
  });
});

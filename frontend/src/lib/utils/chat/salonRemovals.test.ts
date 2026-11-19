import { noteSalonRowRemoved, watchSalonRemovals } from './salonRemovals';

describe('a live removal is seen by the page reads in hand, and only by them', () => {
  it('notes the id in every open watch, never in one opened after it or already closed', () => {
    noteSalonRowRemoved('before-any-watch');
    const a = watchSalonRemovals();
    const b = watchSalonRemovals();
    b.close();
    noteSalonRowRemoved('r1');
    const c = watchSalonRemovals();

    expect(a.has('r1')).toBe(true);
    expect(a.has('before-any-watch')).toBe(false);
    expect(b.has('r1')).toBe(false);
    expect(c.has('r1')).toBe(false);
    a.close();
    a.close();
    c.close();
  });
});

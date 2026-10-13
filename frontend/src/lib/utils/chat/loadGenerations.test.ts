import { createLoadGenerations } from './loadGenerations';

describe('createLoadGenerations - the latest load started is the only one that applies', () => {
  it('a lone load is the latest', () => {
    const gens = createLoadGenerations();
    const a = gens.begin('salon');
    expect(gens.isLatest('salon', a)).toBe(true);
  });

  it('a later start makes an earlier load stale, whichever finishes first', () => {
    const gens = createLoadGenerations();
    const a = gens.begin('salon');
    const b = gens.begin('salon');
    expect(gens.isLatest('salon', b)).toBe(true);
    expect(gens.isLatest('salon', a)).toBe(false);
  });

  it('keys are independent', () => {
    const gens = createLoadGenerations();
    const a = gens.begin('salon-1');
    gens.begin('salon-2');
    expect(gens.isLatest('salon-1', a)).toBe(true);
  });

  it('a generation never matches another key', () => {
    const gens = createLoadGenerations();
    const a = gens.begin('salon-1');
    expect(gens.isLatest('salon-2', a)).toBe(false);
  });
});

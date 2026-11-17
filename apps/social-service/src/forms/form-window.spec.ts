import {
  FORM_WINDOW_CLOSED,
  FORM_WINDOW_NOT_YET,
  FORM_WINDOW_OPEN,
  formWindowState,
} from './form-window';

/** The ONE rule that says whether a form takes answers: the state every read carries and every refusal obeys. */
describe('formWindowState', () => {
  const now = new Date('2026-11-17T12:00:00.000Z');
  it('is open with no bounds', () => {
    expect(formWindowState({ opensAt: null, closedAt: null }, now)).toBe(FORM_WINDOW_OPEN);
  });
  it('is not-yet before the opening, open at the opening instant', () => {
    expect(
      formWindowState({ opensAt: new Date('2026-11-17T12:00:01Z'), closedAt: null }, now)
    ).toBe(FORM_WINDOW_NOT_YET);
    expect(
      formWindowState({ opensAt: new Date('2026-11-17T12:00:00Z'), closedAt: null }, now)
    ).toBe(FORM_WINDOW_OPEN);
  });
  it('is closed once the end is strictly past, open AT the end instant (the refusal rule)', () => {
    expect(
      formWindowState({ opensAt: null, closedAt: new Date('2026-11-17T11:59:59Z') }, now)
    ).toBe(FORM_WINDOW_CLOSED);
    expect(
      formWindowState({ opensAt: null, closedAt: new Date('2026-11-17T12:00:00Z') }, now)
    ).toBe(FORM_WINDOW_OPEN);
    expect(
      formWindowState({ opensAt: null, closedAt: new Date('2026-11-17T12:00:01Z') }, now)
    ).toBe(FORM_WINDOW_OPEN);
  });
});

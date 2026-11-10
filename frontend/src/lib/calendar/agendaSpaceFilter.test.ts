// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agendaSpaceOptions,
  coerceAgendaSpaceValue,
  hasSeveralSpaces,
  narrowingOf,
  readRememberedSpaceValue,
  rememberSpaceValue,
} from './agendaSpaceFilter';

const icmSe = { formation: 'ICM', campus: 'saint-etienne' };
const ismSe = { formation: 'ISMIN', campus: 'saint-etienne' };
const icmGa = { formation: 'ICM', campus: 'gardanne' };

describe('the options come from the spaces the reader reaches', () => {
  it('lists "all", then each campus, then each formation, once', () => {
    const options = agendaSpaceOptions([icmSe, ismSe, icmGa]);
    expect(options.map((o) => o.value)).toEqual([
      '',
      'campus:saint-etienne',
      'campus:gardanne',
      'formation:ICM',
      'formation:ISMIN',
    ]);
  });

  it('offers nothing a reader does not reach', () => {
    const values = agendaSpaceOptions([icmSe, ismSe]).map((o) => o.value);
    expect(values).not.toContain('campus:gardanne');
    expect(values).not.toContain('formation:FSSS');
  });

  it('drops an option equivalent to "all": a campus when every space is on it', () => {
    expect(agendaSpaceOptions([icmSe, ismSe]).map((o) => o.value)).toEqual([
      '',
      'formation:ICM',
      'formation:ISMIN',
    ]);
  });

  it('drops an option equivalent to "all": a formation when every space is that one', () => {
    expect(agendaSpaceOptions([icmSe, icmGa]).map((o) => o.value)).toEqual([
      '',
      'campus:saint-etienne',
      'campus:gardanne',
    ]);
  });

  it('drops a space this client cannot name', () => {
    const options = agendaSpaceOptions([icmSe, { formation: 'ICM', campus: 'mars' }]);
    expect(options).toEqual([]);
  });
});

describe('the filter is hidden for a reader with one space', () => {
  it('has nothing to offer for none or one space', () => {
    expect(hasSeveralSpaces([])).toBe(false);
    expect(hasSeveralSpaces([icmSe])).toBe(false);
    expect(agendaSpaceOptions([])).toEqual([]);
    expect(agendaSpaceOptions([icmSe])).toEqual([]);
  });

  it('shows for two spaces', () => {
    expect(hasSeveralSpaces([icmSe, icmGa])).toBe(true);
  });
});

describe('the narrowing the feed is asked for', () => {
  it('is none for "all" and for anything unknown', () => {
    expect(narrowingOf('')).toEqual({ campus: '', formation: '' });
    expect(narrowingOf('campus:mars')).toEqual({ campus: '', formation: '' });
    expect(narrowingOf('garbage')).toEqual({ campus: '', formation: '' });
  });

  it('is one side for a campus or a formation', () => {
    expect(narrowingOf('campus:gardanne')).toEqual({ campus: 'gardanne', formation: '' });
    expect(narrowingOf('formation:ISMIN')).toEqual({ campus: '', formation: 'ISMIN' });
  });
});

describe('a remembered choice', () => {
  beforeEach(() => localStorage.clear());

  it('is read back for the same reader and only for them', () => {
    rememberSpaceValue('a', 'campus:gardanne');
    expect(readRememberedSpaceValue('a')).toBe('campus:gardanne');
    expect(readRememberedSpaceValue('b')).toBe('');
  });

  it('is forgotten by choosing "all"', () => {
    rememberSpaceValue('a', 'formation:ICM');
    rememberSpaceValue('a', '');
    expect(readRememberedSpaceValue('a')).toBe('');
  });

  it('is dropped when the reader no longer reaches it', () => {
    const options = agendaSpaceOptions([icmSe, ismSe]);
    expect(coerceAgendaSpaceValue('campus:gardanne', options)).toBe('');
    expect(coerceAgendaSpaceValue('formation:ICM', options)).toBe('formation:ICM');
  });

  it('is dropped for a reader with one space, whose filter is hidden', () => {
    expect(coerceAgendaSpaceValue('formation:ICM', agendaSpaceOptions([icmSe]))).toBe('');
  });

  it('is nothing without a signed-in reader', () => {
    rememberSpaceValue(null, 'campus:gardanne');
    expect(readRememberedSpaceValue(null)).toBe('');
  });
});

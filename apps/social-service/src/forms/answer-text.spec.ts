import { answerText, type AnswerQuestion } from './answer-text';

/**
 * The reading of a stored answer, server side - which is the reading that reaches the XLSX.
 *
 * `answerText.test.ts` in the frontend asserts the same cases against the copy the responses table
 * shows. The two files are a declared duplicate and a gate refuses them drifting; these suites are
 * why that gate matters - a drift here is the spreadsheet and the screen disagreeing about what
 * somebody answered.
 *
 * Table-driven because every case is one input and one string, and because the shape of a test
 * should not be mistaken for the thing under test.
 */
describe('answerText', () => {
  const CHOICE: AnswerQuestion = {
    options: [
      { id: 'o1', label: "Humani'Mines" },
      { id: 'o2', label: 'BDS' },
    ],
  };
  const YES_NO: AnswerQuestion = {
    options: [
      { id: 'y', label: 'Oui' },
      { id: 'n', label: 'Non' },
    ],
  };

  it.each([
    ['a free answer reads as itself', 'Un texte libre', {}, 'Un texte libre'],
    ['an option id becomes its label', 'o1', CHOICE, "Humani'Mines"],
    ['a value naming no option is kept', 'Supprimee depuis', CHOICE, 'Supprimee depuis'],
    ['a checkbox answer joins its labels', ['o2', 'o1'], CHOICE, "BDS, Humani'Mines"],
    ['a scale answer reads as its number', 4, {}, '4'],
    // The export read `if (!ans)` until 2026-09-20 and dropped a zero as if it were no answer.
    ['a zero is an answer, not emptiness', 0, {}, '0'],
    // The defect this pair was written for: the cell held {"Lundi":"Oui"}.
    [
      'a matrix reads as row/value pairs',
      { Lundi: 'y', Mardi: 'n' },
      YES_NO,
      'Lundi: Oui; Mardi: Non',
    ],
    ['a blank matrix row is dropped', { Lundi: ['Midi'], Mardi: [] }, {}, 'Lundi: Midi'],
    ['an unanswered question is empty', undefined, {}, ''],
    ['a null answer is empty', null, {}, ''],
    ['an empty string is empty', '', {}, ''],
    ['an empty list is empty', [], {}, ''],
  ])('%s', (_name, answer, question, expected) => {
    expect(answerText(answer, question as AnswerQuestion)).toBe(expected);
  });

  it('never stringifies an object into the cell', () => {
    expect(answerText({ Lundi: 'y' }, YES_NO)).not.toContain('{');
  });
});

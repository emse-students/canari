import { describe, expect, it } from 'vitest';
import { answerText, type AnswerQuestion } from './answerText';

/**
 * The reading of a stored answer, client side.
 *
 * `answer-text.spec.ts` in social-service asserts the SAME cases against the copy that builds the
 * XLSX. A divergence between the two files is the screen and the spreadsheet disagreeing about what
 * somebody answered, which is what the declared-duplicate gate and these two suites exist to catch.
 */

const CHOICE: AnswerQuestion = {
  options: [
    { id: 'o1', label: "Humani'Mines" },
    { id: 'o2', label: 'BDS' },
  ],
};

describe('answerText', () => {
  it('reads a free answer as itself', () => {
    expect(answerText('Parce que le projet porte sur le handicap', {})).toBe(
      'Parce que le projet porte sur le handicap'
    );
  });

  it('resolves an option id to the label the form gives it', () => {
    expect(answerText('o1', CHOICE)).toBe("Humani'Mines");
  });

  // An option's id is OPTIONAL, so an older form stores the label itself. Neither is an error.
  it('keeps a value that names no option', () => {
    expect(answerText('Une asso supprimee depuis', CHOICE)).toBe('Une asso supprimee depuis');
  });

  it('joins a checkbox answer as labels, in the order answered', () => {
    expect(answerText(['o2', 'o1'], CHOICE)).toBe("BDS, Humani'Mines");
  });

  it('reads a scale answer as its number', () => {
    expect(answerText(4, {})).toBe('4');
  });

  // A scale can be answered zero. The export read `if (!ans)` and silently dropped those.
  it('reads a zero as an answer and not as emptiness', () => {
    expect(answerText(0, {})).toBe('0');
  });

  // The defect this pair was written for: the export put {"Lundi":"Oui"} in the cell.
  it('reads a matrix as row/value pairs and never as JSON', () => {
    const text = answerText(
      { Lundi: 'y', Mardi: 'n' },
      {
        options: [
          { id: 'y', label: 'Oui' },
          { id: 'n', label: 'Non' },
        ],
      }
    );
    expect(text).toBe('Lundi: Oui; Mardi: Non');
    expect(text).not.toContain('{');
  });

  it('drops a matrix row that was left blank', () => {
    expect(answerText({ Lundi: ['Midi'], Mardi: [] }, {})).toBe('Lundi: Midi');
  });

  it('is empty for a question nobody answered', () => {
    expect(answerText(undefined, {})).toBe('');
    expect(answerText(null, {})).toBe('');
    expect(answerText('', {})).toBe('');
    expect(answerText([], {})).toBe('');
  });
});

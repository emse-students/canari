import { describe, expect, it } from 'vitest';
import {
  answerText,
  commentText,
  noteKeyOwner,
  otherText,
  type AnswerQuestion,
} from './answerText';

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

// A file answer is an opaque id; what a reader sees is a word, never the id.
describe('answerText - a file answer', () => {
  const FILE_ID = '11111111-1111-4111-8111-111111111111';
  const FILE: AnswerQuestion = { type: 'file' };
  const words = (deleted: string[] = []) => ({
    file: 'Fichier',
    fileDeleted: 'Fichier supprime',
    deletedFiles: new Set(deleted),
  });

  it('reads a kept file as the word for a file', () => {
    expect(answerText(FILE_ID, FILE, words())).toBe('Fichier');
  });

  it('reads a purged file as deleted', () => {
    expect(answerText(FILE_ID, FILE, words([FILE_ID]))).toBe('Fichier supprime');
  });

  it('is empty when no file was sent', () => {
    expect(answerText('', FILE, words())).toBe('');
  });

  it('refuses to read a file answer without words, rather than print its id', () => {
    expect(() => answerText(FILE_ID, FILE)).toThrow('words of its reader');
  });
});

// The comment and "Autre" texts of a choice answer (owner, 2026-11-21): same cases as the server copy.
describe('answerText - the "Autre" option and the free comment', () => {
  const COLOUR: AnswerQuestion = {
    options: [
      { id: 'red', label: 'Rouge' },
      { id: 'oth', label: 'Autre', other: true },
    ],
  };

  it('reads "Autre" as what was typed beside it, alone or among several', () => {
    expect(answerText('oth', COLOUR, undefined, null, 'Vert')).toBe('Autre: Vert');
    expect(answerText(['red', 'oth'], COLOUR, undefined, null, 'Vert')).toBe('Rouge, Autre: Vert');
    expect(answerText('oth', COLOUR)).toBe('Autre');
    expect(answerText('red', COLOUR, undefined, null, 'ignored')).toBe('Rouge');
  });

  it('reads the comment and the typed text out of the record, trimmed, empty when absent', () => {
    const record = { 'q#comment': ' ok ', 'q#other': 'Vert' };
    expect(commentText(record, 'q')).toBe('ok');
    expect(otherText(record, 'q')).toBe('Vert');
    expect(commentText({}, 'q')).toBe('');
  });

  it('names the question a key belongs to', () => {
    expect(noteKeyOwner('q#comment')).toEqual({ itemId: 'q', kind: 'comment' });
    expect(noteKeyOwner('q')).toBeNull();
  });
});

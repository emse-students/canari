import { describe, expect, it } from 'vitest';
import {
  FORM_FILE_ACCEPT,
  FORM_FILE_MAX_BYTES,
  fileQuestionProblem,
  hasFileQuestion,
  isValidFileRetention,
  pickedFileProblem,
  pickedFileType,
} from './fileQuestion';
import { m } from '$lib/paraglide/messages';

/**
 * The page's own checks on a file question: the same refusals the server makes, said in the
 * reader's language before a save or an upload rather than after one.
 */
const FILE_ITEM = { type: 'file' };
const TEXT_ITEM = { type: 'short_text' };

describe('hasFileQuestion', () => {
  it('finds a file question among the others', () => {
    expect(hasFileQuestion([TEXT_ITEM, FILE_ITEM])).toBe(true);
    expect(hasFileQuestion([TEXT_ITEM])).toBe(false);
  });
});

describe('isValidFileRetention', () => {
  it('accepts a whole number of days from 1 to 30', () => {
    expect(isValidFileRetention(1)).toBe(true);
    expect(isValidFileRetention(30)).toBe(true);
  });

  it('refuses 0, 31, a fraction and an empty field', () => {
    expect(isValidFileRetention(0)).toBe(false);
    expect(isValidFileRetention(31)).toBe(false);
    expect(isValidFileRetention(2.5)).toBe(false);
    expect(isValidFileRetention(undefined)).toBe(false);
  });
});

describe('fileQuestionProblem', () => {
  const form = (over: Record<string, unknown> = {}) => ({
    items: [FILE_ITEM],
    isPublic: false,
    anonymous: false,
    fileRetentionDays: 7,
    ...over,
  });

  it('says nothing about a form without a file question, whatever its settings', () => {
    expect(
      fileQuestionProblem(form({ items: [TEXT_ITEM], isPublic: true, fileRetentionDays: 0 }))
    ).toBeNull();
  });

  it('refuses a public form with the public reason', () => {
    expect(fileQuestionProblem(form({ isPublic: true }))).toBe(m.form_public_hint_blocked_file());
  });

  it('refuses an anonymous form with the anonymous reason', () => {
    expect(fileQuestionProblem(form({ anonymous: true }))).toBe(m.form_anonymous_hint_file());
  });

  it('refuses a retention outside 1 to 30', () => {
    expect(fileQuestionProblem(form({ fileRetentionDays: 31 }))).toBe(
      m.form_file_retention_invalid()
    );
  });

  it('accepts a member form with a valid retention', () => {
    expect(fileQuestionProblem(form())).toBeNull();
  });
});

describe('pickedFileProblem', () => {
  it('accepts a PDF under the cap', () => {
    expect(pickedFileProblem({ name: 'a.pdf', type: 'application/pdf', size: 1000 })).toBeNull();
  });

  it('refuses a type the server does not take', () => {
    expect(pickedFileProblem({ name: 'a.html', type: 'text/html', size: 10 })).toBe(
      m.form_file_error_type()
    );
  });

  it('refuses a file over 8 MiB', () => {
    expect(
      pickedFileProblem({ name: 'a.png', type: 'image/png', size: FORM_FILE_MAX_BYTES + 1 })
    ).toBe(m.form_file_error_size());
  });

  it('judges a file with NO declared type (an Android picker) by its extension', () => {
    expect(pickedFileProblem({ name: 'Scan 12.PDF', type: '', size: 10 })).toBeNull();
    expect(pickedFileProblem({ name: 'photo.jpeg', type: '', size: 10 })).toBeNull();
    expect(pickedFileProblem({ name: 'notes.txt', type: '', size: 10 })).toBe(
      m.form_file_error_type()
    );
    expect(pickedFileProblem({ name: 'no-extension', type: '', size: 10 })).toBe(
      m.form_file_error_type()
    );
  });

  it('refuses HEIC with its own sentence, by type or by extension', () => {
    expect(pickedFileProblem({ name: 'IMG_1.HEIC', type: 'image/heic', size: 10 })).toBe(
      m.form_file_error_heic()
    );
    expect(pickedFileProblem({ name: 'IMG_1.heif', type: '', size: 10 })).toBe(
      m.form_file_error_heic()
    );
  });
});

describe('pickedFileType', () => {
  it('keeps a declared type and names one from the extension otherwise', () => {
    expect(pickedFileType({ name: 'x.png', type: 'image/png' })).toBe('image/png');
    expect(pickedFileType({ name: 'x.webp', type: '' })).toBe('image/webp');
    expect(pickedFileType({ name: 'x', type: '' })).toBe('');
  });
});

describe('FORM_FILE_ACCEPT', () => {
  it('lists the types AND the extensions, for pickers that filter by extension only', () => {
    const accept = FORM_FILE_ACCEPT.split(',');
    expect(accept).toEqual(expect.arrayContaining(['application/pdf', '.pdf', '.jpg', '.webp']));
  });
});

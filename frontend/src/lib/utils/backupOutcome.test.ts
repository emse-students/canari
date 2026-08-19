import { BackupError, type BackupErrorCode } from '$lib/backup';
import {
  backupErrorOutcome,
  backupExportFailure,
  backupExportOutcome,
  backupImportOutcome,
} from './backupOutcome';

/**
 * One code, one sentence, and the developer detail never among them.
 *
 * The switch this covers is the ONLY place a backup refusal becomes words. What matters is that
 * every code produces its own sentence - a mapper that quietly returned the generic one for a code
 * it had not learned would look like it worked and tell every user the same nothing.
 */

const ALL_CODES: BackupErrorCode[] = [
  'not_a_backup',
  'too_old',
  'wrong_key',
  'corrupted',
  'too_large',
];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('backupErrorOutcome', () => {
  it('gives every code its own sentence', () => {
    const sentences = ALL_CODES.map(
      (code) => backupErrorOutcome(new BackupError(code, 'detail')).text
    );

    expect(sentences.every((s) => s.length > 0)).toBe(true);
    // Distinct: two codes sharing a sentence means one of them tells the user nothing specific.
    expect(new Set(sentences).size).toBe(ALL_CODES.length);
    expect(sentences.every((s) => !s.includes('detail'))).toBe(true);
  });

  it('marks every refusal as a failure', () => {
    for (const code of ALL_CODES) {
      expect(backupErrorOutcome(new BackupError(code, 'd')).ok).toBe(false);
    }
  });

  it('ACCUSES on anything that arrived unclassified', () => {
    const error = vi.spyOn(console, 'error');

    const outcome = backupErrorOutcome(new TypeError('storage quota exceeded'));

    expect(outcome.ok).toBe(false);
    expect(outcome.text.length).toBeGreaterThan(0);
    // An unclassified failure on a path this deliberate is the visible end of something upstream,
    // so it is logged at a level that says so rather than being folded into the generic sentence.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unclassified'));
  });

  it('logs the detail without ever showing it', () => {
    const warn = vi.spyOn(console, 'warn');

    const outcome = backupErrorOutcome(new BackupError('corrupted', 'message m-42: no id'));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('m-42'));
    expect(outcome.text).not.toContain('m-42');
  });
});

describe('backupImportOutcome', () => {
  it('says something different when the backup came from another device', () => {
    const same = backupImportOutcome({ conversations: 3, messages: 90, isSameDevice: true });
    const other = backupImportOutcome({ conversations: 3, messages: 90, isSameDevice: false });

    expect(same.ok).toBe(true);
    expect(other.ok).toBe(true);
    // Those conversations arrive read-only and stay that way until the exporting device invites
    // this one back; a user told only "restored" reads the silence that follows as a bug.
    expect(other.text).not.toBe(same.text);
    expect(other.text.length).toBeGreaterThan(same.text.length);
  });

  it('carries the counts, which are the only untranslatable part', () => {
    const outcome = backupImportOutcome({ conversations: 7, messages: 412, isSameDevice: true });

    expect(outcome.text).toContain('7');
    expect(outcome.text).toContain('412');
  });
});

describe('the export outcomes', () => {
  it('separates a file produced from one that was not', () => {
    expect(backupExportOutcome().ok).toBe(true);
    expect(backupExportFailure(new Error('disk full')).ok).toBe(false);
  });

  it('never puts the raw cause in front of the user', () => {
    const outcome = backupExportFailure(new Error('EACCES /Users/someone/Downloads'));

    expect(outcome.text).not.toContain('EACCES');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });
});

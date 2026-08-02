import { formatFileSize } from './fileSize';
import { setLocale } from '$lib/paraglide/runtime';

describe('formatFileSize', () => {
  beforeEach(() => setLocale('fr', { reload: false }));

  it('keeps whole bytes below one kilobyte', () => {
    expect(formatFileSize(0)).toBe('0 o');
    expect(formatFileSize(512)).toBe('512 o');
    expect(formatFileSize(1023)).toBe('1023 o');
  });

  it('steps by 1024 and keeps one decimal', () => {
    expect(formatFileSize(152_371)).toBe('148.8 Ko');
    expect(formatFileSize(1536 * 1024)).toBe('1.5 Mo');
  });

  it('drops a decimal that is only a zero, which is noise', () => {
    expect(formatFileSize(512 * 1024)).toBe('512 Ko');
    expect(formatFileSize(24 * 1024 * 1024)).toBe('24 Mo');
    expect(formatFileSize(1024 * 1024)).toBe('1 Mo');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 Go');
  });

  it('stops at gigabytes rather than inventing a unit', () => {
    expect(formatFileSize(4096 * 1024 * 1024 * 1024)).toBe('4096 Go');
  });

  it('treats a negative or non-finite size as zero', () => {
    expect(formatFileSize(-1)).toBe('0 o');
    expect(formatFileSize(Number.NaN)).toBe('0 o');
  });

  it('localizes the unit, which is the whole point of routing it through Paraglide', () => {
    setLocale('en', { reload: false });
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(152_371)).toBe('148.8 KB');
    expect(formatFileSize(24 * 1024 * 1024)).toBe('24 MB');
  });
});

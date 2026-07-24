import { trimComposerText, trimComposerTextIfNeeded } from './composerText';

describe('trimComposerText', () => {
  it('removes trailing newlines and spaces', () => {
    expect(trimComposerText('hello\n\n')).toBe('hello');
    expect(trimComposerText('hello  \n  ')).toBe('hello');
  });

  it('removes leading whitespace', () => {
    expect(trimComposerText('\n\nhello')).toBe('hello');
  });

  it('preserves internal newlines', () => {
    expect(trimComposerText('line1\nline2\n')).toBe('line1\nline2');
  });

  it('reports whether trimming changed the value', () => {
    expect(trimComposerTextIfNeeded('text\n')).toEqual({ text: 'text', changed: true });
    expect(trimComposerTextIfNeeded('text')).toEqual({ text: 'text', changed: false });
  });
});

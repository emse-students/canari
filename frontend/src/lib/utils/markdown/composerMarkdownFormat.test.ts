import { applyComposerMarkdownFormat } from './composerMarkdownFormat';

function mockComposer(selection: { start: number; end: number }) {
  return {
    getSelectionRange: () => selection,
    setSelectionRange: vi.fn(),
    focusEditor: vi.fn(),
  } as unknown as import('$lib/components/shared/MentionComposerInput.svelte').default;
}

describe('applyComposerMarkdownFormat', () => {
  it('wraps selection in bold markers', async () => {
    let text = 'hello world';
    const composer = mockComposer({ start: 6, end: 11 });
    await applyComposerMarkdownFormat(
      'bold',
      () => text,
      (t) => {
        text = t;
      },
      composer
    );
    expect(text).toBe('hello **world**');
    expect(composer.setSelectionRange).toHaveBeenCalledWith(8, 13);
  });

  it('prefixes a heading line', async () => {
    let text = '';
    const composer = mockComposer({ start: 0, end: 0 });
    await applyComposerMarkdownFormat(
      'heading',
      () => text,
      (t) => {
        text = t;
      },
      composer
    );
    expect(text).toBe('## Titre');
  });
});

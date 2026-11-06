import { m } from '$lib/paraglide/messages';

const toasts: Array<[string, string | undefined]> = [];
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (message: string, type?: string) => toasts.push([message, type]),
}));
import { applyComposerMarkdownFormat } from './composerMarkdownFormat';

function mockComposer(selection: { start: number; end: number }) {
  return {
    getSelectionRange: () => selection,
    setSelectionRange: vi.fn(),
    focusEditor: vi.fn(),
  } as unknown as import('$lib/components/shared/MentionComposerInput.svelte').default;
}

/** Runs one toolbar action over `text` with the given selection and reports what it left. */
async function apply(type: string, initial: string, selection: { start: number; end: number }) {
  let text = initial;
  const composer = mockComposer(selection);
  await applyComposerMarkdownFormat(
    type,
    () => text,
    (t) => {
      text = t;
    },
    composer
  );
  return { text, composer };
}

describe('applyComposerMarkdownFormat', () => {
  it('wraps selection in bold markers', async () => {
    const { text, composer } = await apply('bold', 'hello world', { start: 6, end: 11 });

    expect(text).toBe('hello **world**');
    expect(composer.setSelectionRange).toHaveBeenCalledWith(8, 13);
  });

  it('prefixes a heading line', async () => {
    const { text } = await apply('heading', '', { start: 0, end: 0 });

    expect(text).toBe(`## ${m.md_placeholder_heading()}`);
  });

  /**
   * THE PLACEHOLDER IS WHAT THE READER IS ABOUT TO TYPE OVER, so the selection has to land on it
   * exactly. It used to end at `selStart + 6` - the length of the French word that was hardcoded
   * there - which selects the wrong span for a placeholder of any other length, and every
   * translation of it is another length.
   */
  it('selects the whole link placeholder, whatever its length', async () => {
    const placeholder = m.md_placeholder_link_text();
    const { text, composer } = await apply('link', '', { start: 0, end: 0 });

    expect(text).toBe(`[${placeholder}](url)`);
    expect(composer.setSelectionRange).toHaveBeenCalledWith(1, 1 + placeholder.length);
    expect(text.slice(1, 1 + placeholder.length)).toBe(placeholder);
  });

  it('keeps the selection as the link text when there is one', async () => {
    const { text, composer } = await apply('link', 'see docs', { start: 4, end: 8 });

    expect(text).toBe('see [docs](url)');
    expect(composer.setSelectionRange).toHaveBeenCalledWith(11, 14);
  });

  /**
   * Nothing types a string as user-visible, so the only way a placeholder can be caught going out
   * untranslated is to assert that each one IS the message. They are inserted into the reader's own
   * text, which makes them the most visible strings in the file.
   */
  it('takes every placeholder from the message catalogue', async () => {
    const cases: [string, string][] = [
      ['bold', m.md_placeholder_bold()],
      ['italic', m.md_placeholder_italic()],
      ['strikethrough', m.md_placeholder_strikethrough()],
      ['quote', m.md_placeholder_quote()],
      ['code', m.md_placeholder_code()],
      ['list', m.md_placeholder_list()],
    ];

    for (const [type, placeholder] of cases) {
      const { text } = await apply(type, '', { start: 0, end: 0 });
      expect(text).toContain(placeholder);
    }
  });

  /**
   * A STYLE MARKED WOULD NOT DRAW IS NOT WRITTEN (owner, 2026-11-06): the text stays as it was, the
   * selection is not moved, and the member is told with a toast in their language.
   */
  it('leaves the text unchanged and shows a toast when a style cannot be written cleanly', async () => {
    toasts.length = 0;
    const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = '___efghi__ ghijklm ghijk bcdefghi_';
    const { text, composer } = await apply('italic', original, { start: 14, end: 16 });
    expect(text).toBe(original);
    expect(composer.setSelectionRange).not.toHaveBeenCalled();
    expect(toasts).toEqual([[m.md_toolbar_refused(), 'warning']]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('REFUSED italic');
    warn.mockRestore();
  });

  it('shows no toast when the style is written', async () => {
    toasts.length = 0;
    await apply('bold', 'hello world', { start: 6, end: 11 });
    expect(toasts).toEqual([]);
  });
});

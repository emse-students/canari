import { tick } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';

/**
 * Applies a markdown formatting action to a {@link MentionComposerInput} value.
 * Mirrors the toolbar behaviour in post / profile / association composers.
 */
export async function applyComposerMarkdownFormat(
  type: string,
  getText: () => string,
  setText: (text: string) => void,
  composer: MentionComposerInput | null
): Promise<void> {
  if (!composer) return;

  const text = getText();
  const { start: selStart, end: selEnd } = composer.getSelectionRange();
  const selected = text.slice(selStart, selEnd);
  let newText = text;
  let newSelStart = selStart;
  let newSelEnd = selStart;

  const doWrap = (pre: string, suf: string, ph: string) => {
    const inner = selected || ph;
    newText = text.slice(0, selStart) + pre + inner + suf + text.slice(selEnd);
    newSelStart = selStart + pre.length;
    newSelEnd = newSelStart + inner.length;
  };
  const doPrefix = (pre: string, ph: string) => {
    const inner = selected || ph;
    newText = text.slice(0, selStart) + pre + inner + text.slice(selEnd);
    newSelStart = selStart + pre.length;
    newSelEnd = newSelStart + inner.length;
  };

  switch (type) {
    case 'bold':
      doWrap('**', '**', m.md_placeholder_bold());
      break;
    case 'italic':
      doWrap('*', '*', m.md_placeholder_italic());
      break;
    case 'strikethrough':
      doWrap('~~', '~~', m.md_placeholder_strikethrough());
      break;
    case 'heading':
      doPrefix('## ', m.md_placeholder_heading());
      break;
    case 'quote':
      doPrefix('> ', m.md_placeholder_quote());
      break;
    case 'code':
      doWrap('`', '`', m.md_placeholder_code());
      break;
    case 'list':
      doPrefix('- ', m.md_placeholder_list());
      break;
    case 'link':
      if (selected) {
        newText = text.slice(0, selStart) + `[${selected}](url)` + text.slice(selEnd);
        newSelStart = selStart + selected.length + 3;
        newSelEnd = newSelStart + 3;
      } else {
        // The selection lands on the placeholder itself, so its LENGTH decides where it ends -
        // a literal 6 was the length of the French word and silently mis-selected any other.
        const placeholder = m.md_placeholder_link_text();
        newText = text.slice(0, selStart) + `[${placeholder}](url)` + text.slice(selEnd);
        newSelStart = selStart + 1;
        newSelEnd = newSelStart + placeholder.length;
      }
      break;
    default:
      return;
  }

  setText(newText);
  await tick();
  composer.focusEditor();
  composer.setSelectionRange(newSelStart, newSelEnd);
}

import { tick } from 'svelte';
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
      doWrap('**', '**', 'texte en gras');
      break;
    case 'italic':
      doWrap('*', '*', 'texte en italique');
      break;
    case 'strikethrough':
      doWrap('~~', '~~', 'texte barré');
      break;
    case 'heading':
      doPrefix('## ', 'Titre');
      break;
    case 'quote':
      doPrefix('> ', 'citation');
      break;
    case 'code':
      doWrap('`', '`', 'code');
      break;
    case 'list':
      doPrefix('- ', 'élément');
      break;
    case 'link':
      if (selected) {
        newText = text.slice(0, selStart) + `[${selected}](url)` + text.slice(selEnd);
        newSelStart = selStart + selected.length + 3;
        newSelEnd = newSelStart + 3;
      } else {
        newText = text.slice(0, selStart) + '[texte](url)' + text.slice(selEnd);
        newSelStart = selStart + 1;
        newSelEnd = selStart + 6;
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

import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';

/**
 * TEXT AND IMAGE BLOCKS: ITEMS OF A FORM THAT ARE NOT QUESTIONS (owner, 2026-11-21).
 *
 * They sit in the form's one ordered `items` list, so the editor's order, drag and duplicate need
 * nothing new; the server's half is `apps/social-service/src/forms/form-blocks.ts`, which stores a
 * block reduced to these fields and drops any answer keyed by one.
 *
 * - `text_block`: `label` an optional heading, `description` an optional paragraph in the Markdown
 *   of the form's own description (`ProfileBioMarkdown`); one of the two is there.
 * - `image_block`: `imageUrl` (the question-image upload, a public asset a guest can read),
 *   `imageAlt`, and an optional caption in `label`.
 *
 * A block takes no answer: no number, no input, never required, never a column of the responses or
 * the export, never the subject of a condition.
 */

export const TEXT_BLOCK_TYPE = 'text_block';
export const IMAGE_BLOCK_TYPE = 'image_block';

/** The item types that are content, not questions. */
export const FORM_BLOCK_TYPES: readonly string[] = [TEXT_BLOCK_TYPE, IMAGE_BLOCK_TYPE];

/** Whether a stored type is a block's. */
export function isFormBlockType(type: string | undefined): boolean {
  return type !== undefined && FORM_BLOCK_TYPES.includes(type);
}

/** Whether an item is a block (content) rather than a question. */
export function isFormBlock(item: { type?: string } | null | undefined): boolean {
  return isFormBlockType(item?.type);
}

/** The items that take an answer: every item but the blocks, in order. */
export function questionItemsOf<T extends { type?: string }>(
  items: readonly T[] | null | undefined
): T[] {
  return (items ?? []).filter((item) => !isFormBlock(item));
}

/**
 * The number each QUESTION is shown with, counting questions only, by id: a block between two
 * questions does not make the reader skip a number.
 */
export function questionNumbers(
  items: readonly { id: string; type?: string }[]
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const item of items) {
    if (!isFormBlock(item)) numbers.set(item.id, numbers.size + 1);
  }
  return numbers;
}

/** A new, empty block of `type`, as the editor inserts it. */
export function newFormBlock(type: string): {
  id: string;
  type: string;
  label: string;
  required: false;
  description?: string;
} {
  Log.d('formBlocks', `new ${type}`);
  const id = crypto.randomUUID();
  return type === TEXT_BLOCK_TYPE
    ? { id, type, label: '', required: false, description: '' }
    : { id, type, label: '', required: false };
}

/**
 * What a block is SENT as: the fields a block has and nothing else, so a card that was something
 * else first carries no option, row or condition the server would refuse (`FORM_BLOCK_INVALID`).
 */
export function formBlockPayload(item: {
  id?: string;
  type: string;
  label?: string;
  description?: string;
  imageUrl?: string;
  imageAlt?: string;
}): Record<string, unknown> {
  return {
    ...(item.id ? { id: item.id } : {}),
    type: item.type,
    label: item.label ?? '',
    required: false,
    ...(item.description?.trim() ? { description: item.description } : {}),
    ...(item.type === IMAGE_BLOCK_TYPE
      ? {
          imageUrl: item.imageUrl ?? '',
          ...(item.imageAlt?.trim() ? { imageAlt: item.imageAlt } : {}),
        }
      : {}),
  };
}

/**
 * Why the server would refuse a block at save (`normaliseFormBlocks`), as a sentence, or null: a
 * text block holding no text, an image block holding no image.
 */
export function formBlockProblem(item: {
  type?: string;
  label?: string;
  description?: string;
  imageUrl?: string;
}): string | null {
  if (item.type === TEXT_BLOCK_TYPE && !item.label?.trim() && !item.description?.trim()) {
    return m.form_block_text_empty();
  }
  if (item.type === IMAGE_BLOCK_TYPE && !item.imageUrl) return m.form_block_image_missing();
  return null;
}

/**
 * The text alternative of an image block: what the organiser typed, else its caption, else a
 * sentence naming the form - never empty, since the picture is the block's whole content.
 */
export function formBlockImageAlt(
  item: { imageAlt?: string; label?: string },
  formTitle: string
): string {
  return (
    item.imageAlt?.trim() ||
    item.label?.trim() ||
    m.form_block_image_alt_default({ title: formTitle })
  );
}

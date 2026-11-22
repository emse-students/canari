import { Logger } from '@nestjs/common';
import {
  FORM_BLOCK_INVALID,
  FORM_ITEM_DESCRIPTION_MAX_LENGTH,
  FORM_ITEM_LABEL_MAX_LENGTH,
  formRefusal,
} from './answer-bounds';

/**
 * TEXT AND IMAGE BLOCKS: ITEMS OF A FORM THAT ARE NOT QUESTIONS (owner, 2026-11-21).
 *
 * A form's `items` is one ordered list, so a block sits anywhere among the questions and the editor's
 * reordering, drag and duplication need nothing new. What makes a block a block is its `type`:
 *
 * - `text_block`: `label` is an optional heading, `description` an optional paragraph (Markdown, the
 *   renderer of the form's own description); one of the two is there.
 * - `image_block`: `imageUrl` is a public asset uploaded through the question-image route, with
 *   `imageAlt` and an optional caption in `label` - the question image's storage, citation, release
 *   and reconciliation unchanged (`form-item-images.service.ts`).
 *
 * A block takes no answer: never required, no option, row, scale, priced grid or condition, and no
 * question's condition may name one. An answer keyed by a block is dropped before anything reads it
 * (`withoutBlockAnswers`), so submissions, exports, results, pricing and the edit lock never see one.
 * The fields left are the ones a question already has, so an older app (whose `FormItemDto` and
 * fill page know them) draws the block's text and image and says it cannot answer it - which, never
 * required, blocks nothing.
 */

const logger = new Logger('FormBlocks');

/** The item types that are content, not questions. */
export const FORM_BLOCK_TYPES = ['text_block', 'image_block'] as const;

/** Whether an item is a block (content) rather than a question. */
export function isFormBlock(item: { type?: unknown } | null | undefined): boolean {
  return (FORM_BLOCK_TYPES as readonly unknown[]).includes(item?.type);
}

/** The items that take an answer: every item but the blocks, in order. */
export function questionItemsOf<T extends { type?: unknown }>(
  items: readonly T[] | null | undefined
): T[] {
  return (items ?? []).filter((item) => !isFormBlock(item));
}

/** What a saved item may carry, as far as the block rules read it. */
interface SavedFormItem {
  id?: string;
  type?: string;
  label?: unknown;
  description?: unknown;
  required?: unknown;
  options?: unknown;
  rows?: unknown;
  scale?: unknown;
  requireEveryRow?: unknown;
  productGrid?: unknown;
  showIf?: unknown;
  dependsOn?: unknown;
  dependsValue?: unknown;
  imageUrl?: unknown;
  imageAlt?: unknown;
}

/** The form-level settings that may name a question by id, as the form WILL hold them. */
export interface FormBlockRefs {
  submitCondition?: unknown;
  priceMatrix?: unknown;
}

/**
 * Refuses a `submitCondition.answer.questionId` or a price-grid dimension of kind `answer` that
 * names a block: no answer could ever meet it, so the form would admit nobody or price nobody.
 * (The generic parsers refuse it too, but as an untyped 400 about options; this is the typed one.)
 */
function assertNoBlockReference(blockIds: ReadonlySet<string | undefined>, refs: FormBlockRefs) {
  if (blockIds.size === 0) return;
  const named: string[] = [];
  const condition = refs.submitCondition as
    | { answer?: { questionId?: unknown } }
    | null
    | undefined;
  if (typeof condition?.answer?.questionId === 'string') named.push(condition.answer.questionId);
  const dimensions = (refs.priceMatrix as { dimensions?: unknown } | null | undefined)?.dimensions;
  if (Array.isArray(dimensions)) {
    for (const d of dimensions as { kind?: unknown; questionId?: unknown }[]) {
      if (d?.kind === 'answer' && typeof d.questionId === 'string') named.push(d.questionId);
    }
  }
  const hit = named.find((id) => blockIds.has(id));
  if (hit === undefined) return;
  logger.log(`[FORM_BLOCK] save refused: the form's condition or price grid names block ${hit}`);
  throw formRefusal(
    FORM_BLOCK_INVALID,
    `The submit condition or price grid names block ${hit}, which takes no answer.`,
    hit
  );
}

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function refuse(item: SavedFormItem, why: string): never {
  logger.log(`[FORM_BLOCK] save refused: ${item.type} ${item.id ?? '?'} ${why}`);
  throw formRefusal(FORM_BLOCK_INVALID, `Block ${item.id ?? '?'} ${why}.`, item.id);
}

/**
 * Judges the blocks of `items` and returns the list as it is STORED: each block reduced to the
 * fields a block has (`id`, `type`, `label`, `description`, `imageUrl`, `imageAlt`, `required:
 * false`), every question untouched.
 *
 * Refused with {@link FORM_BLOCK_INVALID}: a block `required`, carrying options, rows, a priced grid
 * or a condition (what a client sends only when it takes the block for a question); a text block
 * with neither heading nor paragraph; an image block with no image; a label that is not text; and a
 * QUESTION whose condition (`showIf.answer` or the legacy `dependsOn`), the form's
 * `submitCondition` or a price-grid `answer` dimension names a block, which no answer could ever
 * meet. Dropped silently, because an older editor adds them to every card it
 * draws and they mean nothing: an empty option or row list, `scale`, `requireEveryRow`.
 */
export function normaliseFormBlocks<T extends SavedFormItem>(
  items: readonly T[] | null | undefined,
  refs: FormBlockRefs = {}
): T[] {
  const list = items ?? [];
  const blockIds = new Set(
    list
      .filter(isFormBlock)
      .map((item) => item.id)
      .filter(Boolean)
  );
  assertNoBlockReference(blockIds, refs);
  const out = list.map((item) => {
    if (!isFormBlock(item)) {
      const answer = (item.showIf as { answer?: { questionId?: unknown } } | null | undefined)
        ?.answer;
      const subject = answer?.questionId ?? item.dependsOn;
      if (typeof subject === 'string' && blockIds.has(subject)) {
        logger.log(
          `[FORM_BLOCK] save refused: question ${item.id ?? '?'} depends on block ${subject}`
        );
        throw formRefusal(
          FORM_BLOCK_INVALID,
          `Question ${item.id ?? '?'} depends on a block, which takes no answer.`,
          item.id
        );
      }
      return item;
    }
    if (item.required === true) refuse(item, 'is required');
    if (isNonEmptyList(item.options)) refuse(item, 'carries options');
    if (isNonEmptyList(item.rows)) refuse(item, 'carries rows');
    if (item.productGrid != null) refuse(item, 'carries a priced grid');
    if (item.showIf != null || hasText(item.dependsOn)) refuse(item, 'carries a condition');
    if (item.label !== undefined && typeof item.label !== 'string') refuse(item, 'label not text');
    // `ValidateIf` lifts the DTO's length cap on a block's label, so the cap is held here.
    if (typeof item.label === 'string' && item.label.length > FORM_ITEM_LABEL_MAX_LENGTH) {
      refuse(item, 'label too long');
    }
    if (
      typeof item.description === 'string' &&
      item.description.length > FORM_ITEM_DESCRIPTION_MAX_LENGTH
    ) {
      refuse(item, 'description too long');
    }
    if (item.type === 'text_block' && !hasText(item.label) && !hasText(item.description)) {
      refuse(item, 'holds no text');
    }
    if (item.type === 'image_block' && !hasText(item.imageUrl)) refuse(item, 'holds no image');
    const stored: SavedFormItem = {
      ...(item.id !== undefined ? { id: item.id } : {}),
      type: item.type,
      label: typeof item.label === 'string' ? item.label : '',
      required: false,
      ...(hasText(item.description) ? { description: item.description } : {}),
      ...(item.type === 'image_block'
        ? {
            imageUrl: item.imageUrl,
            ...(hasText(item.imageAlt) ? { imageAlt: item.imageAlt } : {}),
          }
        : {}),
    };
    return stored as T;
  });
  const blocks = out.filter(isFormBlock).length;
  if (blocks > 0) logger.debug(`[FORM_BLOCK] ${blocks} block(s) among ${out.length} item(s)`);
  return out;
}

/**
 * `answers` without any key naming a block of `items`. No page of this build sends one - a block
 * draws no input - so a key here is a client gone wrong, and it is logged at WARN and dropped
 * before the submit or the edit reads anything, so no block answer is ever stored, priced, exported
 * or required.
 */
export function withoutBlockAnswers<V>(
  items: readonly { id: string; type?: unknown }[] | null | undefined,
  answers: Record<string, V>,
  where: string
): Record<string, V> {
  const blockIds = new Set((items ?? []).filter(isFormBlock).map((item) => item.id));
  if (blockIds.size === 0) return answers;
  const kept = Object.entries(answers).filter(([key]) => !blockIds.has(key));
  const dropped = Object.keys(answers).length - kept.length;
  if (dropped > 0) {
    logger.warn(`[FORM_BLOCK] ${where}: ${dropped} answer(s) keyed by a block dropped`);
  }
  return Object.fromEntries(kept);
}

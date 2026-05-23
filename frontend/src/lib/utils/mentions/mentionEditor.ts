import { formatMentionToken, MENTION_UUID_TOKEN_RE } from '$lib/utils/mentions';
import { splitTextWithMentions } from '$lib/utils/mentions.parse';
import {
  hasFormattedMarkdownPreview,
  markdownStructureKey,
  parseInlineMarkdownPreview,
  type InlineMarkdownStyle,
  type InlinePreviewSegment,
} from '$lib/utils/markdown/inlinePreview';
import { resolveUserDisplayName } from '$lib/utils/users/displayName';

export const MENTION_CHIP_CLASS = 'mention-editor-chip';
export const MENTION_CHIP_SELECTOR = `[data-mention-id].${MENTION_CHIP_CLASS}`;

export const MD_MUTED_CLASS = 'md-composer-muted';
export const MD_ITALIC_CLASS = 'md-composer-italic';
export const MD_UNDERLINE_CLASS = 'md-composer-underline';
export const MD_BOLD_CLASS = 'md-composer-bold';
export const MD_BOLD_ITALIC_CLASS = 'md-composer-bold-italic';
export const MD_STRIKE_CLASS = 'md-composer-strike';
export const MD_CODE_CLASS = 'md-composer-code';

export type MentionEditorRenderOptions = {
  markdownPreview?: boolean;
};

/** Serializes a mention editor DOM tree to plain text with `@[uuid]` tokens. */
export function serializeMentionEditor(root: HTMLElement): string {
  let out = '';

  function walk(node: Node, isBlockChild = false): void {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const mentionId = el.dataset.mentionId;
    if (mentionId) {
      out += formatMentionToken(mentionId);
      return;
    }

    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }

    const isBlock = el.tagName === 'DIV' || el.tagName === 'P';
    if (isBlock && isBlockChild && out.length > 0 && !out.endsWith('\n')) {
      out += '\n';
    }

    for (const child of el.childNodes) {
      walk(child, isBlock);
    }
  }

  for (const child of root.childNodes) {
    walk(child, false);
  }
  return out;
}

function createMentionChip(userId: string, label: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = MENTION_CHIP_CLASS;
  span.contentEditable = 'false';
  span.dataset.mentionId = userId;
  span.setAttribute('role', 'link');
  span.tabIndex = -1;
  span.textContent = `@${label}`;
  void resolveUserDisplayName(userId).then((resolved) => {
    if (resolved && span.isConnected && span.dataset.mentionId === userId) {
      span.textContent = `@${resolved}`;
    }
  });
  return span;
}

function appendTextWithBreaks(parent: HTMLElement, text: string): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) parent.appendChild(document.createTextNode(lines[i]));
    if (i < lines.length - 1) parent.appendChild(document.createElement('br'));
  }
}

function appendMutedSpan(parent: HTMLElement, text: string): void {
  const span = document.createElement('span');
  span.className = MD_MUTED_CLASS;
  span.appendChild(document.createTextNode(text));
  parent.appendChild(span);
}

const MD_STYLE_CLASS: Record<InlineMarkdownStyle, string> = {
  italic: MD_ITALIC_CLASS,
  bold: MD_BOLD_CLASS,
  underline: MD_UNDERLINE_CLASS,
  strike: MD_STRIKE_CLASS,
};

function appendFormattedSpan(parent: HTMLElement, className: string, text: string): void {
  const span = document.createElement('span');
  span.className = className;
  appendTextWithBreaks(span, text);
  parent.appendChild(span);
}

/** Nests style spans so underline + strike (etc.) all apply without CSS overrides. */
function appendCombinedFormattedSpan(
  parent: HTMLElement,
  styles: readonly InlineMarkdownStyle[],
  text: string
): void {
  if (styles.length === 0) {
    appendTextWithBreaks(parent, text);
    return;
  }
  const set = new Set(styles);
  if (set.size === 2 && set.has('bold') && set.has('italic')) {
    appendFormattedSpan(parent, MD_BOLD_ITALIC_CLASS, text);
    return;
  }
  if (styles.length === 1) {
    appendFormattedSpan(parent, MD_STYLE_CLASS[styles[0]], text);
    return;
  }
  let node: HTMLElement = parent;
  for (const style of styles) {
    const span = document.createElement('span');
    span.className = MD_STYLE_CLASS[style];
    node.appendChild(span);
    node = span;
  }
  appendTextWithBreaks(node, text);
}

function appendInlinePreviewSegment(parent: HTMLElement, seg: InlinePreviewSegment): void {
  switch (seg.kind) {
    case 'text':
      appendTextWithBreaks(parent, seg.value);
      break;
    case 'escape':
      appendMutedSpan(parent, '\\');
      parent.appendChild(document.createTextNode(seg.char));
      break;
    case 'delimiter':
      appendMutedSpan(parent, seg.marker);
      break;
    case 'formatted':
      appendCombinedFormattedSpan(parent, seg.styles, seg.content);
      break;
    case 'code':
      appendFormattedSpan(parent, MD_CODE_CLASS, seg.content);
      break;
  }
}

function appendComposerText(parent: HTMLElement, text: string, markdownPreview: boolean): void {
  if (!markdownPreview) {
    appendTextWithBreaks(parent, text);
    return;
  }
  for (const seg of parseInlineMarkdownPreview(text)) {
    appendInlinePreviewSegment(parent, seg);
  }
}

export function countMentionTokens(text: string): number {
  const re = new RegExp(MENTION_UUID_TOKEN_RE.source, MENTION_UUID_TOKEN_RE.flags);
  return [...text.matchAll(re)].length;
}

/**
 * Whether styled markdown preview should be applied when rebuilding the DOM.
 */
export function composerMarkdownPreviewEnabled(
  plainText: string,
  options: MentionEditorRenderOptions = {}
): boolean {
  return (options.markdownPreview ?? false) && hasFormattedMarkdownPreview(plainText);
}

/**
 * Whether the composer DOM should be rebuilt.
 * Re-renders when markdown structure changes (delimiter opened/closed) or when editing inside
 * closed formatted spans (keeps the caret in the content node, not after a muted delimiter).
 */
export function shouldRerenderComposerDom(
  plainText: string,
  lastRendered: string,
  options: MentionEditorRenderOptions = {}
): boolean {
  if (!options.markdownPreview) return false;
  if (!plainText && !lastRendered) return false;
  if (plainText === lastRendered) return false;
  if (markdownStructureKey(plainText) !== markdownStructureKey(lastRendered)) return true;
  return hasFormattedMarkdownPreview(plainText);
}

/** True when plain text has `@[uuid]` tokens not yet rendered as chips. */
export function needsMentionChipRender(root: HTMLElement, plainText: string): boolean {
  const expected = countMentionTokens(plainText);
  if (expected === 0) return false;
  return root.querySelectorAll(MENTION_CHIP_SELECTOR).length < expected;
}

/** Renders plain text (mentions + optional Discord-style markdown preview) into the editor. */
export function renderPlainTextToMentionEditor(
  root: HTMLElement,
  text: string,
  options: MentionEditorRenderOptions = {}
): void {
  const markdownPreview = options.markdownPreview ?? false;
  root.innerHTML = '';
  if (!text) return;

  const parts = splitTextWithMentions(text);
  for (const part of parts) {
    if (part.type === 'text') {
      appendComposerText(root, part.value, markdownPreview);
    } else if (part.type === 'mention') {
      root.appendChild(createMentionChip(part.userId, part.label));
    } else if (part.type === 'hashtag') {
      root.appendChild(document.createTextNode(`#${part.value}`));
    }
  }
}

function measureOffset(root: HTMLElement, container: Node, offset: number): number {
  if (!root.contains(container)) return 0;
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  const tmp = document.createElement('div');
  tmp.appendChild(range.cloneContents());
  return serializeMentionEditor(tmp).length;
}

/** Plain-text selection offsets inside the editor. */
export function getPlainTextSelection(root: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return { start: 0, end: 0 };
  return {
    start: measureOffset(root, range.startContainer, range.startOffset),
    end: measureOffset(root, range.endContainer, range.endOffset),
  };
}

function locatePlainTextOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = target;
  let found: { node: Node; offset: number } = { node: root, offset: 0 };

  function walk(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        found = { node, offset: remaining };
        return true;
      }
      remaining -= len;
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;

    const el = node as HTMLElement;
    const mentionId = el.dataset.mentionId;
    if (mentionId) {
      const len = formatMentionToken(mentionId).length;
      if (remaining <= len) {
        const parent = el.parentNode ?? root;
        const index = Array.from(parent.childNodes).indexOf(el);
        found = { node: parent, offset: Math.max(0, index) };
        return true;
      }
      remaining -= len;
      return false;
    }

    if (el.tagName === 'BR') {
      if (remaining <= 1) {
        const parent = el.parentNode ?? root;
        const index = Array.from(parent.childNodes).indexOf(el);
        found = { node: parent, offset: index };
        return true;
      }
      remaining -= 1;
      return false;
    }

    for (const child of el.childNodes) {
      if (walk(child)) return true;
    }
    return false;
  }

  walk(root);
  return found;
}

export function setPlainTextSelection(root: HTMLElement, start: number, end: number = start): void {
  const startPos = locatePlainTextOffset(root, start);
  const endPos = locatePlainTextOffset(root, end);
  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Deletes the mention chip immediately before the caret, if any. */
export function removeMentionChipBeforeCursor(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return false;

  const { startContainer, startOffset } = range;
  let prev: Node | null = null;

  if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
    prev = startContainer.previousSibling;
  } else if (startContainer.nodeType === Node.ELEMENT_NODE) {
    prev = startContainer.childNodes[startOffset - 1] ?? null;
  }

  const chip =
    prev instanceof HTMLElement && prev.matches(MENTION_CHIP_SELECTOR)
      ? prev
      : (prev as HTMLElement | null)?.closest?.(MENTION_CHIP_SELECTOR);
  if (!(chip instanceof HTMLElement)) return false;

  chip.remove();
  return true;
}

export function getMentionChipFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const chip = target.closest(MENTION_CHIP_SELECTOR);
  return chip instanceof HTMLElement ? (chip.dataset.mentionId ?? null) : null;
}

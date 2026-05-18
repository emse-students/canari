import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (userId: string) => userId,
  resolveUserDisplayName: vi.fn().mockResolvedValue(null),
}));

import {
  needsMentionChipRender,
  renderPlainTextToMentionEditor,
  serializeMentionEditor,
} from './mentionEditor';

import { EXAMPLE_MENTION_USER_ID } from '../mentions';

describe('mentionEditor', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it('round-trips @[uuid] through DOM', () => {
    const text = `Salut @[${EXAMPLE_MENTION_USER_ID}]!`;
    renderPlainTextToMentionEditor(root, text);
    expect(serializeMentionEditor(root)).toBe(text);
    expect(root.querySelector('[data-mention-id]')).not.toBeNull();
  });

  it('creates a clickable mention chip element', () => {
    renderPlainTextToMentionEditor(root, `@[${EXAMPLE_MENTION_USER_ID}]`);
    const chip = root.querySelector('[data-mention-id]') as HTMLElement;
    expect(chip?.textContent).toMatch(/^@/);
    expect(chip?.dataset.mentionId).toBe(EXAMPLE_MENTION_USER_ID);
  });

  it('detects raw @[id] text that still needs chip rendering', () => {
    root.textContent = `Salut @[${EXAMPLE_MENTION_USER_ID}]!`;
    expect(needsMentionChipRender(root, `Salut @[${EXAMPLE_MENTION_USER_ID}]!`)).toBe(true);
    renderPlainTextToMentionEditor(root, `Salut @[${EXAMPLE_MENTION_USER_ID}]!`);
    expect(needsMentionChipRender(root, `Salut @[${EXAMPLE_MENTION_USER_ID}]!`)).toBe(false);
  });
});

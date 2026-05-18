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

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

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
    const text = `Salut @[${USER_ID}]!`;
    renderPlainTextToMentionEditor(root, text);
    expect(serializeMentionEditor(root)).toBe(text);
    expect(root.querySelector('[data-mention-id]')).not.toBeNull();
  });

  it('creates a clickable mention chip element', () => {
    renderPlainTextToMentionEditor(root, `@[${USER_ID}]`);
    const chip = root.querySelector('[data-mention-id]') as HTMLElement;
    expect(chip?.textContent).toMatch(/^@/);
    expect(chip?.dataset.mentionId).toBe(USER_ID);
  });

  it('detects raw @[uuid] text that still needs chip rendering', () => {
    root.textContent = `Salut @[${USER_ID}]!`;
    expect(needsMentionChipRender(root, `Salut @[${USER_ID}]!`)).toBe(true);
    renderPlainTextToMentionEditor(root, `Salut @[${USER_ID}]!`);
    expect(needsMentionChipRender(root, `Salut @[${USER_ID}]!`)).toBe(false);
  });
});

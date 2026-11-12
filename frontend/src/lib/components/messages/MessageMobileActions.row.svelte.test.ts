// @vitest-environment happy-dom
/**
 * THE ACTION ROW IS ONE ROW OF ICONS, EVERY VARIANT, EACH NAMED FOR A SCREEN READER.
 *
 * Owner, 2026-11-08: the actions "devraient tenir sur une ligne, quitte a ne pas mettre les
 * textes". Five received-message actions wrapped onto a second row because each carried a label.
 * Pinned here: no visible text, the accessible name and tooltip kept, one container for every
 * variant (own, received, pinned, media, moderator), and the special colours kept.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import MessageMobileActions from './MessageMobileActions.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
let release: (() => void) | null = null;

beforeEach(() => {
  release = adoptTransitionAnimations();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  release?.();
  release = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const noop = () => {};

function open(props: Record<string, unknown>) {
  const component = mount(MessageMobileActions, {
    target: document.body,
    props: { visible: true, onClose: noop, ...props },
  });
  mounted.push(() => unmount(component, { outro: false }));
  flushSync();
  const row = document.body.querySelector<HTMLElement>(
    '[data-keyboard-aware-actions] > div:last-child'
  );
  const buttons = Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  return { row, buttons };
}

const all = {
  onForward: noop,
  onCopy: noop,
  onShare: noop,
  onPin: noop,
  onReply: noop,
  onEdit: noop,
  onDelete: noop,
};

describe('MessageMobileActions action row', () => {
  it('shows a received text message on ONE row with no visible text', () => {
    const { row, buttons } = open({ ...all, isOwn: false });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      m.msg_reply_label(),
      m.msg_forward_label(),
      m.msg_copy_label(),
      m.msg_share_label(),
      m.msg_pin_label(),
    ]);
    expect(row?.className).not.toContain('flex-wrap');
    expect(row?.textContent?.trim()).toBe('');
    for (const b of buttons) {
      expect(b.title).toBe(b.getAttribute('aria-label'));
      expect(b.className).toContain('h-11');
      expect(b.className).toContain('flex-1');
    }
  });

  it('puts the widest variant (own text message, 7 actions) in the same single row', () => {
    const { row, buttons } = open({ ...all, isOwn: true });
    expect(buttons).toHaveLength(7);
    expect(row?.className).not.toContain('flex-wrap');
    expect(row?.className).toContain('max-w-96');
  });

  it('offers Edit on an own message whatever it carries - a media message edits its caption', () => {
    const { buttons } = open({ ...all, isOwn: true });
    const names = buttons.map((b) => b.getAttribute('aria-label'));
    expect(names).toContain(m.common_edit_label());
    expect(names).toContain(m.common_delete_button());
  });

  it('drops Edit when the bubble says the message cannot be edited (a poll, a deleted row)', () => {
    const { buttons } = open({ ...all, isOwn: true, canEdit: false });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).not.toContain(m.common_edit_label());
  });

  it('offers Delete to a moderator on a received message', () => {
    const { buttons } = open({ ...all, isOwn: false, canModerate: true });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toContain(m.common_delete_button());
  });

  it('keeps the accent of Pin, names Unpin when pinned, and runs then closes', () => {
    const onPin = vi.fn();
    const onClose = vi.fn();
    const { buttons } = open({ ...all, onPin, onClose, pinned: true });
    const pin = buttons.find((b) => b.getAttribute('aria-label') === m.msg_unpin_label())!;
    expect(pin.className).toContain('text-accent-text');
    pin.click();
    expect(onPin).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders no row at all for a deleted message', () => {
    const { buttons } = open({ ...all, isOwn: true, isDeleted: true });
    expect(buttons).toHaveLength(0);
  });
});

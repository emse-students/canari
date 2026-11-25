// @vitest-environment happy-dom
/**
 * A SYSTEM NOTICE ABOUT A DEVICE OR AN ASK IS NEVER THE TILE'S PREVIEW (owner, 2026-10-31): a pending
 * join ask is a line in its thread, never in the list, and "X added a device" - written in every
 * conversation shared with X at once - is skipped for the message before it (`listPreview.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const unresolvable = vi.hoisted(() => new Set<string>());
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name(${id})`,
  peekUserDisplayName: (id: string) => (unresolvable.has(id) ? null : `Name(${id})`),
  resolveUserDisplayName: async (id: string) => `Name(${id})`,
}));

import ConversationTile from './ConversationTile.svelte';
import { raiseJoinRequest, resetJoinRequests } from '$lib/utils/chat/joinRequests.svelte';
import {
  deviceAddedLineId,
  isDeviceAddedLine,
  previewContentOf,
} from '$lib/utils/chat/listPreview';
import { m } from '$lib/paraglide/messages';
import { setLocale } from '$lib/paraglide/runtime';
import { Log } from '$lib/utils/Log';
import { mkNoticeEnvelope, serializeEnvelope } from '$lib/envelope';

let target: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(lastMessage?: string) {
  app = mount(ConversationTile, {
    target,
    props: {
      conversationId: 'g1',
      ...(lastMessage !== undefined ? { lastMessage } : {}),
      contactName: 'group-1',
      displayName: 'Group',
      conversationType: 'group',
      isReady: true,
      isSelected: false,
      unreadCount: 0,
      onClick: () => {},
    },
  });
  flushSync();
}

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  resetJoinRequests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target.remove();
  vi.restoreAllMocks();
});

describe('ConversationTile - what the preview line shows', () => {
  it('shows the ordinary preview when nothing is pending', () => {
    render();
    expect(target.textContent).toContain(m.chat_e2e_established_preview());
  });

  it('never reads a pending join ask - the ask is a line in its thread', () => {
    raiseJoinRequest({ groupId: 'g1', requesterUserId: 'carol', requesterDeviceId: 'd1' });
    render();
    expect(target.textContent).not.toContain('veut rejoindre');
    expect(target.textContent).toContain(m.chat_e2e_established_preview());
  });
});

describe('previewContentOf - a device notice is never the preview', () => {
  const said = { id: 'm1', content: 'bonjour' };
  const notice = (n: number) => ({ id: deviceAddedLineId('g1', `peer:d${n}|fp`), content: 'x' });

  it('skips the device notices for the last message before them', () => {
    expect(previewContentOf([said, notice(1), notice(2)])).toBe('bonjour');
    expect(isDeviceAddedLine(notice(1).id)).toBe(true);
    expect(isDeviceAddedLine(said.id)).toBe(false);
  });

  it('is nothing when the notices are all there is', () => {
    expect(previewContentOf([notice(1)])).toBeUndefined();
    expect(previewContentOf([])).toBeUndefined();
  });

  it('draws a group notice in the reader language, not the stored writer-language sentence', () => {
    setLocale('en', { reload: false });
    try {
      render(
        serializeEnvelope(
          mkNoticeEnvelope('Ana a ajouté Ben au groupe', {
            event: 'memberAdded',
            actor: 'u-a',
            targets: ['u-b'],
          })
        )
      );
      expect(target.textContent).toContain('Name(u-a) added Name(u-b) to the group');
      expect(target.textContent).not.toContain('a ajouté');
    } finally {
      setLocale('fr', { reload: false });
    }
  });

  it('logs a notice preview only when its names still do not resolve after resolution', async () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => undefined);
    const notice = (target: string) =>
      serializeEnvelope(
        mkNoticeEnvelope('stored', { event: 'memberAdded', actor: 'u-a', targets: [target] })
      );
    render(notice('u-ok'));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
    unmount(app!);
    app = null;
    unresolvable.add('u-lost');
    render(notice('u-lost'));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    unresolvable.clear();
  });
});

// @vitest-environment happy-dom
/**
 * A JOIN ROW NAMES ITS MEMBER BY ID AND DRAWS THE NAME WHEN IT ARRIVES (owner, 2026-11-09, 1.6.8:
 * "Utilisateur inconnu a rejoint" for the latest join, forever). The row is written before the
 * newcomer's profile is readable; a stored sentence is never redrawn, so the row must carry the id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));
vi.mock('$lib/stores/user', () => ({
  currentUserId: vi.fn(() => 'u-me'),
  getSavedDisplayName: vi.fn(() => null),
  fetchUserProfile: vi.fn(),
  isAbsentUserError: () => false,
  isDeletedAccountError: () => false,
}));

import MessageBubble from './MessageBubble.svelte';
import * as userStore from '$lib/stores/user';
import { mkNoticeEnvelope, serializeEnvelope, type NoticeSpec } from '$lib/envelope';
import { noticeText } from '$lib/utils/chat/noticeText';
import { seedUserDisplayName } from '$lib/utils/users/displayName';
import { flushMacrotask } from '../../../test/flush';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a notice row is redrawn when the member name arrives', () => {
  it('draws the name, not the unknown label, once the profile is fetched', async () => {
    seedUserDisplayName('u-adder', 'Alice Adder');
    let release: (v: unknown) => void = () => {};
    vi.mocked(userStore.fetchUserProfile).mockImplementation(
      () => new Promise((r) => (release = r)) as never
    );
    // The stored sentence is the one a failed lookup baked in.
    const spec: NoticeSpec = { event: 'memberAdded', actor: 'u-adder', targets: ['u-newcomer'] };
    const stored = serializeEnvelope(
      mkNoticeEnvelope(
        noticeText(spec, (id) => (id === 'u-adder' ? 'Alice Adder' : 'Utilisateur inconnu')),
        spec
      )
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(MessageBubble, {
      target,
      props: {
        messageId: 'n1',
        senderId: 'system',
        currentUserId: 'u-me',
        content: stored,
        timestamp: new Date(),
        isOwn: false,
        isSystem: true,
      },
    });
    flushSync();
    expect(target.textContent).toContain('Alice Adder');
    expect(target.textContent).toContain('Utilisateur inconnu');
    release({ id: 'u-newcomer', firstName: 'Ghost', lastName: 'Newcomer', displayName: null });
    await flushMacrotask();
    flushSync();
    expect(target.textContent).toContain('Ghost Newcomer');
    unmount(app);
  });

  it('keeps the stored sentence while a name is unknown here, never the unknown label', async () => {
    // A cold cache (a relaunch, offline): the writer knew both names, this device knows none yet and
    // its lookup gets no answer. Drawing the ids now would erase two names the row already holds.
    vi.mocked(userStore.fetchUserProfile).mockImplementation(() => new Promise(() => {}) as never);
    const spec: NoticeSpec = { event: 'memberRemoved', actor: 'u-cold-a', targets: ['u-cold-b'] };
    const sentence = noticeText(spec, (id) => (id === 'u-cold-a' ? 'Ana Cold' : 'Ben Cold'));
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(MessageBubble, {
      target,
      props: {
        messageId: 'n2',
        senderId: 'system',
        currentUserId: 'u-me',
        content: serializeEnvelope(mkNoticeEnvelope(sentence, spec)),
        timestamp: new Date(),
        isOwn: false,
        isSystem: true,
      },
    });
    flushSync();
    await flushMacrotask();
    flushSync();
    expect(target.textContent).toContain('Ana Cold');
    expect(target.textContent).toContain('Ben Cold');
    expect(target.textContent).not.toContain('Utilisateur inconnu');
    unmount(app);
  });
});

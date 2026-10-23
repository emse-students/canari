// @vitest-environment happy-dom
/**
 * THE BOX A COMMENT IS WRITTEN IN (the comment refonte, 2026-10-21). Pinned: a failed send is said
 * beside the box; a draft is kept per post and comes back; the identity (anonymous, an association)
 * is what is SENT, survives a failed send and does not stick to the next comment; Enter sends on a
 * physical keyboard and is a new line on a touch one; the counter shows near the limit.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import CommentComposer from './CommentComposer.svelte';
import type { CommentOutcome } from '$lib/posts/postCommentThread.svelte';
import type { CommentIdentity } from '$lib/posts/postIdentity';
import { COMMENT_MAX_LENGTH } from '$lib/posts/api';
import { loadPostCommentDraft, savePostCommentDraft } from '$lib/posts/postCommentDraft';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const env = vi.hoisted(() => ({ coarse: false }));

vi.mock('$lib/utils/pointerDevice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/pointerDevice')>()),
  isCoarsePointerDevice: () => env.coarse,
}));
vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/user')>()),
  getSavedUserId: () => 'u1',
  getSavedDisplayName: () => 'Ada Lovelace',
  isGlobalAdmin: () => false,
}));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listMyAssociations: vi.fn().mockResolvedValue([
    {
      id: 'a1',
      name: 'BDE Mines',
      slug: 'bde-mines',
      logoUrl: null,
      permissions: 1, // POST_AS_ASSO
      isAdmin: true,
    },
    {
      id: 'a2',
      name: 'Roster only',
      slug: 'roster',
      logoUrl: null,
      permissions: 2, // another right, not POST_AS_ASSO
      isAdmin: true,
    },
  ]),
  listAssociations: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];
beforeEach(() => {
  env.coarse = false;
  localStorage.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

type Send = { parentId?: string; identity: CommentIdentity };

function mountComposer(
  props: {
    value?: string;
    sendError?: string;
    replyTo?: { id: string; name: string } | null;
    outcome?: CommentOutcome;
  } = {}
) {
  const onSubmit = vi.fn(async (_send: Send) => props.outcome ?? ('sent' as CommentOutcome));
  const onChange = vi.fn();
  const onRestoreReply = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CommentComposer, {
    target,
    props: {
      postId: 'p1',
      value: props.value ?? '',
      onChange,
      placeholder: 'Write',
      submitting: false,
      currentUserId: 'u1',
      replyTo: props.replyTo ?? null,
      onCancelReply: vi.fn(),
      onRestoreReply,
      onSubmit,
      sendError: props.sendError,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { target, onSubmit, onChange, onRestoreReply };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    flushSync();
  }
  await tick();
};
const sendButton = (t: HTMLElement) =>
  t.querySelector<HTMLButtonElement>(`button[aria-label="${m.post_send_comment_label()}"]`)!;
const editor = (t: HTMLElement) => t.querySelector<HTMLElement>('[contenteditable="true"]')!;

/** Chooses `label` in the identity picker, as a person does: open it, tap the option. */
async function chooseIdentity(t: HTMLElement, label: string) {
  t.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click();
  await settle();
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((o) =>
    o.textContent?.includes(label)
  );
  expect(option, `option "${label}" is offered`).toBeDefined();
  option!.click();
  await settle();
}

describe('a failed send', () => {
  it('is said beside the box, as an alert', () => {
    const { target } = mountComposer({ sendError: 'Impossible de commenter' });
    const alert = target.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Impossible de commenter');
  });

  it('shows no alert when nothing failed', () => {
    const { target } = mountComposer();
    expect(target.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('the draft', () => {
  it('comes back when the box is opened again, and so does the comment it was answering', async () => {
    savePostCommentDraft('p1', { text: 'half a thought', parentId: 'c9' });
    const { onChange, onRestoreReply } = mountComposer();
    await settle();
    expect(onChange).toHaveBeenCalledWith('half a thought');
    expect(onRestoreReply).toHaveBeenCalledWith('c9');
  });

  it('never overwrites what is already in the box', async () => {
    savePostCommentDraft('p1', { text: 'old draft', parentId: null });
    const { onChange } = mountComposer({ value: 'typing now' });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is kept as the box changes', async () => {
    mountComposer({ value: 'a long reply' });
    await settle();
    expect(loadPostCommentDraft('p1')?.text).toBe('a long reply');
  });

  it('is forgotten when the box is empty', async () => {
    savePostCommentDraft('p1', { text: 'left over', parentId: null });
    mountComposer({ value: '' });
    await settle();
    // Restored once, then the box (still empty in this test) clears it - a draft never outlives an empty box.
    expect(loadPostCommentDraft('p1')).toBeNull();
  });
});

describe('who it is written as', () => {
  it('is the member by default: nothing but the text is asked of the identity', async () => {
    const { target, onSubmit } = mountComposer({ value: 'hello' });
    sendButton(target).click();
    await settle();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ identity: { kind: 'personal' } })
    );
  });

  it('sends as anonymous when the reader chose it, and says what that means', async () => {
    const { target, onSubmit } = mountComposer({ value: 'hello' });
    await chooseIdentity(target, m.post_create_anonymous_label());
    expect(target.textContent).toContain(m.post_comment_anonymous_hint());
    sendButton(target).click();
    await settle();
    expect(onSubmit.mock.calls[0][0].identity).toEqual({ kind: 'anonymous' });
  });

  it('offers only the associations the member may speak for, and sends as the one chosen', async () => {
    const { target, onSubmit } = mountComposer({ value: 'hello' });
    target
      .querySelector('[role="presentation"]')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    target.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click();
    await settle();
    const labels = [...document.querySelectorAll('[role="option"]')].map(
      (o) => o.textContent ?? ''
    );
    expect(labels.some((l) => l.includes('BDE Mines'))).toBe(true);
    expect(labels.some((l) => l.includes('Roster only'))).toBe(false);
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((o) => o.textContent?.includes('BDE Mines'))!
      .click();
    await settle();
    expect(target.textContent).toContain(
      m.post_comment_as_association_caption({ name: 'BDE Mines' })
    );
    sendButton(target).click();
    await settle();
    expect(onSubmit.mock.calls[0][0].identity).toMatchObject({
      kind: 'association',
      association: { id: 'a1', name: 'BDE Mines' },
    });
  });

  it("keeps the identity across a FAILED send: a retry never goes out under the writer's own name", async () => {
    const { target, onSubmit } = mountComposer({ value: 'hello', outcome: 'failed' });
    await chooseIdentity(target, m.post_create_anonymous_label());
    sendButton(target).click();
    await settle();
    expect(target.textContent).toContain(m.post_comment_anonymous_hint());
    sendButton(target).click();
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0].identity).toEqual({ kind: 'anonymous' });
  });

  it("goes back to the member's own name after a SENT comment", async () => {
    const { target } = mountComposer({ value: 'hello', outcome: 'sent' });
    await chooseIdentity(target, m.post_create_anonymous_label());
    sendButton(target).click();
    await settle();
    expect(target.textContent).not.toContain(m.post_comment_anonymous_hint());
  });
});

describe('Enter', () => {
  const pressEnter = (t: HTMLElement, shift = false) =>
    editor(t).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      })
    );

  it('sends on a physical keyboard', async () => {
    const { target, onSubmit } = mountComposer({ value: 'hello' });
    pressEnter(target);
    await settle();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('is a new line with Shift, and on a touch keyboard - where the button sends', async () => {
    const { target, onSubmit } = mountComposer({ value: 'hello' });
    pressEnter(target, true);
    env.coarse = true;
    pressEnter(target);
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('the limit', () => {
  it('shows a counter only near it', () => {
    const quiet = mountComposer({ value: 'short' });
    expect(quiet.target.textContent).not.toContain(`/${COMMENT_MAX_LENGTH}`);
    const loud = mountComposer({ value: 'x'.repeat(COMMENT_MAX_LENGTH - 50) });
    expect(loud.target.textContent).toContain(`/${COMMENT_MAX_LENGTH}`);
  });

  it('does not send an empty box', () => {
    const { target } = mountComposer({ value: '   ' });
    expect(sendButton(target).disabled).toBe(true);
  });
});

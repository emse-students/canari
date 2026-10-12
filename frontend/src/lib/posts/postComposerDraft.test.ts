import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newPollOption } from './pollDraft';
import {
  clearPostComposerDraft,
  postComposerDraftKey,
  emptyPostComposerDraft,
  isPostComposerDraftWorthKeeping,
  loadPostComposerDraft,
  savePostComposerDraft,
  withoutAbandonedAttachments,
} from './postComposerDraft';

/** Signs `id` in the way `getSavedUserId` reads it. */
function signIn(id: string): void {
  localStorage.setItem('canari_saved_user', id);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  signIn('user-a');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('withoutAbandonedAttachments', () => {
  it('drops a poll toggle whose card holds nothing', () => {
    const draft = { ...emptyPostComposerDraft('hello'), includePoll: true };
    expect(withoutAbandonedAttachments(draft).includePoll).toBe(false);
  });

  it('keeps a poll with a question, or with one option written', () => {
    const withQuestion = {
      ...emptyPostComposerDraft(),
      includePoll: true,
      pollQuestion: 'Quand ?',
    };
    expect(withoutAbandonedAttachments(withQuestion).includePoll).toBe(true);
    const withOption = {
      ...emptyPostComposerDraft(),
      includePoll: true,
      pollOptions: [newPollOption(''), newPollOption('Lundi')],
    };
    expect(withoutAbandonedAttachments(withOption).includePoll).toBe(true);
  });

  it('drops a form toggle with no form chosen - the one an account without forms can never satisfy', () => {
    const draft = { ...emptyPostComposerDraft('hello'), includeForm: true, selectedFormId: '' };
    expect(withoutAbandonedAttachments(draft).includeForm).toBe(false);
  });

  it('keeps a form toggle with a form chosen', () => {
    const draft = { ...emptyPostComposerDraft(), includeForm: true, selectedFormId: 'f1' };
    expect(withoutAbandonedAttachments(draft).includeForm).toBe(true);
  });
});

describe('isPostComposerDraftWorthKeeping', () => {
  it('keeps text or a live attachment, and nothing else', () => {
    expect(isPostComposerDraftWorthKeeping(emptyPostComposerDraft())).toBe(false);
    expect(isPostComposerDraftWorthKeeping(emptyPostComposerDraft('  '))).toBe(false);
    expect(isPostComposerDraftWorthKeeping(emptyPostComposerDraft('x'))).toBe(true);
    expect(
      isPostComposerDraftWorthKeeping({ ...emptyPostComposerDraft(), includeForm: true })
    ).toBe(true);
  });
});

describe('loadPostComposerDraft', () => {
  it('restores the text without an abandoned toggle', () => {
    savePostComposerDraft({
      ...emptyPostComposerDraft('mon post'),
      includePoll: true,
      includeForm: true,
    });
    const restored = loadPostComposerDraft();
    expect(restored?.markdown).toBe('mon post');
    expect(restored?.includePoll).toBe(false);
    expect(restored?.includeForm).toBe(false);
  });

  it('restores nothing when the abandoned toggles were all the draft held', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    savePostComposerDraft({ ...emptyPostComposerDraft(), includeForm: true });
    expect(localStorage.getItem(postComposerDraftKey('user-a'))).not.toBeNull();
    expect(loadPostComposerDraft()).toBeNull();
  });

  it('restores a poll the reader had started', () => {
    savePostComposerDraft({ ...emptyPostComposerDraft(), includePoll: true, pollQuestion: 'Où ?' });
    expect(loadPostComposerDraft()?.includePoll).toBe(true);
  });
});

describe('a draft is owned by the account that wrote it', () => {
  it('is invisible to another account on the same device, and survives for its author', () => {
    savePostComposerDraft(emptyPostComposerDraft("le texte d'Alice"));
    signIn('user-b');
    expect(loadPostComposerDraft()).toBeNull();
    signIn('user-a');
    expect(loadPostComposerDraft()?.markdown).toBe("le texte d'Alice");
  });

  it('clears only the signed-in account draft', () => {
    savePostComposerDraft(emptyPostComposerDraft('a'));
    signIn('user-b');
    savePostComposerDraft(emptyPostComposerDraft('b'));
    clearPostComposerDraft();
    expect(loadPostComposerDraft()).toBeNull();
    signIn('user-a');
    expect(loadPostComposerDraft()?.markdown).toBe('a');
  });

  it('drops the old device-global drafts instead of adopting them', () => {
    localStorage.setItem(
      'canari_post_composer_draft',
      JSON.stringify(emptyPostComposerDraft('orphelin'))
    );
    localStorage.setItem('canari_post_draft', 'ancien');
    expect(loadPostComposerDraft()).toBeNull();
    expect(localStorage.getItem('canari_post_composer_draft')).toBeNull();
    expect(localStorage.getItem('canari_post_draft')).toBeNull();
  });

  it('touches nothing while nobody is signed in', () => {
    localStorage.removeItem('canari_saved_user');
    savePostComposerDraft(emptyPostComposerDraft('x'));
    expect(loadPostComposerDraft()).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

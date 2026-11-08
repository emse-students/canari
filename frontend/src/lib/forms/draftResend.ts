/**
 * The background resend of the forms' device copies (`draftCopies.ts`), wired to the session: a pass
 * when the account's session is up, and one each time the browser says the link returned (`online`,
 * a trigger to TRY - never a proof of reachability). Stopped at sign-out, whose erase deletes what
 * is left.
 */
import { createForm, saveFormDraft } from './api';
import { FormDraftConflictError } from './draftConflict';
import {
  formDraftCopyStore,
  resendFormDraftCopies,
  type FormDraftCopy,
  type ResendDeps,
} from './draftCopies';
import { m } from '$lib/paraglide/messages';
import { serverFormDrafts } from '$lib/stores/appVersionCheck.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { currentUserId } from '$lib/stores/userState.svelte';
import { refusalStatus } from '$lib/utils/apiRefusal';

let running: { userId: string; onOnline: () => void } | null = null;

/** The resend's dependencies for `userId`: the real API. */
function depsFor(userId: string): ResendDeps {
  return {
    store: formDraftCopyStore(userId),
    formDrafts: () => serverFormDrafts() === true,
    signedIn: () => currentUserId() === userId,
    // The shell a create page makes first: what is fixed at creation, and the title it is listed
    // under - the SAME create, by its key. The rest is the revision the save below stores.
    createDraft: (copy) =>
      createForm({
        clientCreateId: copy.clientCreateId ?? undefined,
        draft: true,
        title: copy.document.title,
        basePrice: 0,
        currency: 'eur',
        items: [],
        associationId: copy.document.associationId,
      }),
    save: (copy) => saveFormDraft(copy.formId, copy.baseRevision, copy.document, copy.saveId),
    statusOf: refusalStatus,
    conflictOf: (e) =>
      e instanceof FormDraftConflictError
        ? { revision: e.revision, saveId: e.saveId, recentSaveIds: e.recentSaveIds }
        : undefined,
    dropped: tellCopyDropped,
  };
}

/**
 * Tells the member that the edits a closed editor left on this device could not be sent - the form
 * changed elsewhere, or is gone - and names the form: an edit lost in silence is found by hand.
 */
export function tellCopyDropped(copy: Pick<FormDraftCopy, 'document'>): void {
  const title = copy.document.title?.trim() || m.form_draft_copy_untitled();
  showToast(m.form_draft_copy_dropped({ title }), 'warning', 10_000);
}

/** One pass for the running account; its failures are logged, never thrown. */
function pass(userId: string): void {
  resendFormDraftCopies(depsFor(userId)).catch((e: unknown) =>
    console.warn(`[FORM-DRAFT-COPY] resend pass failed: ${e}`)
  );
}

/** Starts the resend of `userId`'s copies: one pass now, one at each `online`. */
export function startFormDraftResend(userId: string): void {
  if (running?.userId === userId) {
    pass(userId);
    return;
  }
  stopFormDraftResend();
  const onOnline = () => pass(userId);
  window.addEventListener('online', onOnline);
  running = { userId, onOnline };
  pass(userId);
}

/** Stops the resend (sign-out); the copies themselves are erased by the sign-out. */
export function stopFormDraftResend(): void {
  if (!running) return;
  window.removeEventListener('online', running.onOnline);
  running = null;
}

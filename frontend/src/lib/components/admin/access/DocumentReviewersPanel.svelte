<script lang="ts">
  /**
   * DOCUMENT REVIEWERS: staff who read every association's public documents.
   *
   * Same template as the named readers. Adding saves at once with "Undo"; removing asks first
   * (user, 2026-10-16), then offers "Undo" too. Undo is the inverse call - there is no undo
   * endpoint - so a removal undone is a NEW grant, dated now and authored by whoever undid it.
   */
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { FileCheckCorner } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import {
    addDocumentReviewer,
    listDocumentReviewers,
    removeDocumentReviewer,
    type DocumentReviewerGrant,
  } from '$lib/associations/api';
  import { reviewerJournal, type JournalLine } from '$lib/admin/readAccess';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast, showUndoToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';
  import AccessSection from './AccessSection.svelte';
  import ReviewerCard from './ReviewerCard.svelte';
  import { createNameBook } from './nameBook.svelte';

  interface Props {
    /** True when a tab above already names this section. */
    titleHidden?: boolean;
  }

  let { titleHidden = false }: Props = $props();

  const names = createNameBook();
  let reviewers = $state<DocumentReviewerGrant[]>([]);
  let loading = $state(true);
  let adding = $state(false);
  let error = $state<string | null>(null);
  /** People with a write in flight - per person, so an undo for one never waits on another. */
  const busy = new SvelteSet<string>();

  const journalLines = $derived<JournalLine[]>(
    reviewerJournal(reviewers).map((line) => ({
      key: line.userId,
      at: line.at,
      text: m.docreview_journal_grant({
        actor: names.nameOf(line.actor),
        name: names.nameOf(line.userId),
      }),
    }))
  );

  function track(list: DocumentReviewerGrant[]) {
    names.resolve(list.flatMap((r) => [r.userId, r.grantedBy]));
  }

  /**
   * Says why a call did nothing: a write for this person is still in flight. Reached by an undo
   * pressed meanwhile; the form's own button is busy-disabled and the card's remove button too.
   */
  function refuseBusy(userId: string): boolean {
    if (!busy.has(userId)) return false;
    Log.d('admin.document-reviewers.write refused, still saving', { userId });
    showToast(m.readaccess_busy(), 'warning');
    return true;
  }

  /**
   * Grants, then lists the new row. `undoable` offers removing it again. Answers whether it
   * succeeded, so the search keeps the person picked when it did not.
   */
  async function grant(userId: string, undoable: boolean): Promise<boolean> {
    if (refuseBusy(userId)) return false;
    busy.add(userId);
    if (undoable) adding = true;
    error = null;
    Log.d('admin.document-reviewers.grant', { userId, undoable });
    try {
      const row = await addDocumentReviewer(userId);
      reviewers = [row, ...reviewers.filter((r) => r.userId !== row.userId)];
      track([row]);
    } catch (e) {
      Log.d('admin.document-reviewers.grant failed', e);
      error = m.common_generic_error_label();
      return false;
    } finally {
      busy.delete(userId);
      if (undoable) adding = false;
    }
    if (undoable) {
      showUndoToast(m.docreview_added_toast({ name: names.nameOf(userId) }), () => {
        Log.d('admin.document-reviewers.undo grant', { userId });
        void revoke(userId, false);
      });
    }
    return true;
  }

  /** Revokes, then drops the row. `undoable` offers granting it again. */
  async function revoke(userId: string, undoable: boolean) {
    if (refuseBusy(userId)) return;
    busy.add(userId);
    error = null;
    Log.d('admin.document-reviewers.revoke', { userId, undoable });
    try {
      await removeDocumentReviewer(userId);
      reviewers = reviewers.filter((r) => r.userId !== userId);
    } catch (e) {
      Log.d('admin.document-reviewers.revoke failed', e);
      error = m.common_delete_error();
      return;
    } finally {
      busy.delete(userId);
    }
    if (undoable) {
      showUndoToast(m.docreview_removed_toast({ name: names.nameOf(userId) }), () => {
        Log.d('admin.document-reviewers.undo revoke', { userId });
        void grant(userId, false);
      });
    }
  }

  async function confirmRevoke(userId: string) {
    const name = names.nameOf(userId);
    const ok = await showConfirm(m.docreview_revoke_confirm({ name }), {
      danger: true,
      confirmLabel: m.docreview_revoke_button(),
    });
    Log.d('admin.document-reviewers.confirmRevoke', { userId, ok });
    if (ok) await revoke(userId, true);
  }

  onMount(async () => {
    try {
      reviewers = await listDocumentReviewers();
      track(reviewers);
    } catch (e) {
      Log.d('admin.document-reviewers.load failed', e);
      error = m.common_load_error();
    } finally {
      loading = false;
    }
  });
</script>

{#if error}
  <p class="text-red-err mb-4 text-sm" role="alert">{error}</p>
{/if}

<AccessSection
  title={m.docreview_title()}
  {titleHidden}
  summary={m.docreview_summary()}
  details={m.docreview_details()}
  addPlaceholder={m.docreview_add_placeholder()}
  addLabel={m.docreview_add_button()}
  inputId="add-reviewer-autocomplete"
  excludeIds={reviewers.map((r) => r.userId)}
  onAdd={(userId) => grant(userId, true)}
  {adding}
  {loading}
  count={reviewers.length}
  emptyIcon={FileCheckCorner}
  emptyTitle={m.docreview_empty()}
  emptyDescription={m.docreview_empty_desc()}
  journal={journalLines}
  journalLabel={m.docreview_current_summary({ count: reviewers.length })}
  journalEmpty={m.docreview_journal_empty()}
  journalNote={m.docreview_journal_note()}
>
  {#snippet list()}
    {#each reviewers as row (row.userId)}
      <ReviewerCard
        name={names.nameOf(row.userId)}
        actorName={names.nameOf(row.grantedBy)}
        grantedAt={row.createdAt}
        removing={busy.has(row.userId)}
        onRemove={() => void confirmRevoke(row.userId)}
      />
    {/each}
  {/snippet}
</AccessSection>

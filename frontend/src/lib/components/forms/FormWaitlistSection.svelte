<script lang="ts">
  import { ListOrdered, Trash2, UserCheck } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { promoteFromWaitlist, type Submission } from '$lib/forms/api';
  import { formCodeMessage } from '$lib/forms/answerBounds';
  import { submitterName } from '$lib/forms/submissionTable';
  import { formatFormOpensAt } from '$lib/posts/postComposerDraft';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * A FORM'S WAITING LIST, FOR ITS MANAGERS (owner decision of 2026-11-23): the waiting answers in
   * ARRIVAL ORDER, apart from the registrations, each with "Inscrire" (a promotion by hand, above
   * the capacity if the form is full) and "Retirer" (the ordinary deletion of an answer). No
   * reordering: the line is the order people came in, and a freed place promotes its head.
   */
  interface Props {
    formId: string;
    /** The waiting answers, already in arrival order (`waitingInOrder`). */
    waiting: Submission[];
    /** The answer currently being deleted, so its control can say so. */
    deletingId: string | null;
    onDelete: (sub: Submission) => void;
    /** Re-reads the answers once a promotion settled, so the registrations and the line follow. */
    onReload: () => Promise<void>;
  }

  let { formId, waiting, deletingId, onDelete, onReload }: Props = $props();

  /** The answer being promoted, so its control can say so. */
  let promotingId = $state<string | null>(null);

  async function promote(sub: Submission): Promise<void> {
    const name = submitterName(sub);
    if (!(await showConfirm(m.form_waitlist_promote_confirm({ name })))) return;
    promotingId = sub.id;
    try {
      await promoteFromWaitlist(formId, sub.id);
      Log.d('FormWaitlistSection', `promoted ${sub.id.slice(0, 8)} by hand`);
      showToast(m.form_waitlist_promoted_toast({ name }), 'info');
    } catch (e: unknown) {
      const code = refusalCode(e);
      const coded = formCodeMessage(code);
      if (coded) {
        Log.w('FormWaitlistSection', `promoting ${sub.id.slice(0, 8)} refused: ${code}`);
      } else {
        console.error(
          `[FORMS] promoting ${sub.id.slice(0, 8)} failed status=${refusalStatus(e) ?? 'transport'}:`,
          e
        );
      }
      showToast(coded ?? m.form_waitlist_promote_failed());
    } finally {
      promotingId = null;
    }
    // Promoted or no longer waiting: either way the line the manager sees is stale.
    await onReload();
  }
</script>

<section
  class="border-cn-border flex flex-col gap-2 rounded-2xl border bg-(--cn-surface) px-4 py-3"
  data-testid="form-waitlist-section"
>
  <div class="flex items-center gap-2">
    <ListOrdered size={16} class="text-text-muted shrink-0" />
    <h3 class="text-text-main text-sm font-bold">
      {m.form_waitlist_section_title({ count: waiting.length })}
    </h3>
  </div>
  <p class="text-text-muted text-xs">{m.form_waitlist_section_note()}</p>
  <ol class="flex flex-col gap-1">
    {#each waiting as sub, index (sub.id)}
      <li class="flex items-center justify-between gap-3 py-1" data-testid="form-waitlist-row">
        <span class="flex min-w-0 items-center gap-2 text-sm">
          <span class="text-text-muted w-6 shrink-0 text-right font-semibold">{index + 1}</span>
          <span class="text-text-main truncate font-medium">{submitterName(sub)}</span>
          <span class="text-text-muted shrink-0 text-xs">{formatFormOpensAt(sub.createdAt)}</span>
        </span>
        <span class="flex shrink-0 items-center gap-1">
          <Button
            variant="soft"
            size="compact"
            disabled={promotingId !== null || deletingId === sub.id}
            loading={promotingId === sub.id}
            onclick={() => void promote(sub)}
          >
            <UserCheck size={14} class="mr-1" />{m.form_waitlist_promote_button()}
          </Button>
          <Button
            variant="ghost"
            size="compact"
            disabled={promotingId !== null || deletingId === sub.id}
            loading={deletingId === sub.id}
            onclick={() => onDelete(sub)}
          >
            <Trash2 size={14} class="mr-1" />{m.form_waitlist_remove_button()}
          </Button>
        </span>
      </li>
    {/each}
  </ol>
</section>

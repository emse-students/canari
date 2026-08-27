<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { reportReasons, type ReportReason } from '$lib/moderation/reasons';

  interface Props {
    /** Whether the dialog is visible. */
    open: boolean;
    /** Dialog title - names what is being reported (a comment, a person). */
    title: string;
    /** What the report is about, shown under the title so the reporter can confirm the target. */
    targetPreview?: string;
    /** True while the report is in flight; disables every control. */
    submitting?: boolean;
    /** Called with the chosen reason. The caller owns the request and its outcome. */
    onSubmit: (reason: ReportReason) => void;
    onClose: () => void;
  }

  let { open, title, targetPreview = '', submitting = false, onSubmit, onClose }: Props = $props();

  const reasons = $derived(reportReasons());
  let selected = $state<ReportReason | ''>('');

  // A dialog reopened on another target must not carry the previous choice.
  $effect(() => {
    if (!open) selected = '';
  });
</script>

<Modal {open} {onClose} {title} maxWidth="max-w-sm" dismissible={!submitting}>
  <div class="space-y-4 px-1 pb-2">
    {#if targetPreview}
      <p class="text-text-muted line-clamp-3 text-sm italic">{targetPreview}</p>
    {/if}

    <div class="space-y-2">
      {#each reasons as reason (reason.value)}
        <button
          type="button"
          class="border-cn-border text-text-main w-full rounded-xl border px-3 py-2.5 text-left text-sm transition-colors hover:border-amber-400 disabled:opacity-40 {selected ===
          reason.value
            ? 'border-amber-400 bg-amber-400/10'
            : ''}"
          onclick={() => (selected = reason.value)}
          disabled={submitting}
        >
          {reason.label}
        </button>
      {/each}
    </div>

    <div class="flex justify-end gap-2 pt-1">
      <button
        type="button"
        class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5"
        onclick={onClose}
        disabled={submitting}
      >
        {m.common_cancel_button()}
      </button>
      <button
        type="button"
        class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
        onclick={() => selected && onSubmit(selected)}
        disabled={submitting || !selected}
      >
        {m.report_dialog_submit_button()}
      </button>
    </div>
  </div>
</Modal>

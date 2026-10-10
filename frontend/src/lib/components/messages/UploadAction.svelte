<script lang="ts">
  import { X, RotateCw } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { uploadPercent, type UploadView } from '$lib/utils/chat/uploadProgress.svelte';

  interface Props {
    /** What the outbox knows about the upload this bubble shows. */
    view: UploadView;
    /** Withdraws the message and stops the transfer. Absent = no cancel (a surface that cannot). */
    onCancel?: () => void;
    /** Tries again now. Offered only while nothing is moving (`stalled` / `waiting`). */
    onRetry?: () => void;
  }

  let { view, onCancel, onRetry }: Props = $props();

  /** The circle's circumference at r = 15 (viewBox 36), so a percentage maps to a dash length. */
  const CIRCUMFERENCE = 2 * Math.PI * 15;

  const percent = $derived(uploadPercent(view));
  const moving = $derived(view.phase === 'uploading' || view.phase === 'preparing');
  const retryable = $derived(
    view.phase === 'stalled' || view.phase === 'waiting' || view.phase === 'blocked'
  );
</script>

<!-- A ring that FILLS with the bytes sent, the cancel cross inside it (Messenger's and WhatsApp's
     gesture), and a retry beside it when nothing is moving. With no honest figure the ring turns
     instead of filling: an indeterminate state must not look like 0 %. -->
<div class="flex shrink-0 items-center gap-1">
  {#if retryable && onRetry}
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      aria-label={m.upload_retry_label()}
      title={m.upload_retry_label()}
      class="ui-icon-button rounded-xl outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current"
    >
      <RotateCw size={18} strokeWidth={2.5} />
    </button>
  {/if}
  <button
    type="button"
    disabled={!onCancel}
    onclick={(e) => {
      e.stopPropagation();
      onCancel?.();
    }}
    aria-label={m.upload_cancel_label()}
    title={m.upload_cancel_label()}
    class="ui-icon-button relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-current"
  >
    <svg
      viewBox="0 0 36 36"
      class="absolute inset-0 h-full w-full -rotate-90 {percent === null && moving
        ? 'animate-spin'
        : ''}"
      aria-hidden="true"
    >
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        stroke="currentColor"
        stroke-opacity="0.2"
        stroke-width="3"
      />
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={CIRCUMFERENCE * (1 - (percent ?? (moving ? 25 : 0)) / 100)}
        class="transition-[stroke-dashoffset] duration-300"
      />
    </svg>
    <X size={14} strokeWidth={2.75} />
  </button>
</div>

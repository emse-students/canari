<script lang="ts">
  import { Copy, ShieldAlert, ShieldCheck } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { copyId } from '$lib/utils/copyId';
  import type { ReportedLineVerdict, ReportedLiveChatLine } from '$lib/moderation/api';

  interface Props {
    /** The kept line as the queue states it; null once the server erased it. */
    line: ReportedLiveChatLine | null;
  }

  let { line }: Props = $props();

  /**
   * One sentence per verdict. Anything but `verified` says WHY the queue shows no text: the server
   * hands the preview over only for a verified line, and an absent proof (`key-rotated`,
   * `unverifiable`) is weighed as `altered` is (`live-report-signature.ts`).
   */
  const verdictText: Record<ReportedLineVerdict, () => string> = {
    verified: () => m.moderation_chat_line_verified(),
    altered: () => m.moderation_chat_line_altered(),
    'key-rotated': () => m.moderation_chat_line_key_rotated(),
    unverifiable: () => m.moderation_chat_line_unverifiable(),
  };

  const verified = $derived(line?.integrity.content === 'verified');
</script>

<!--
  THE ADMIN QUEUE'S CHAT-LINE ROW (WP-L8b): the server's integrity verdict on the kept line, and the
  live it was written in. There is no route to one live (the viewer opens from the feed), so the
  live is named by its copyable id, as ModerationLiveBlock names it.
-->
<div class="mb-3 space-y-1.5 text-xs" data-moderation-chat-line>
  {#if line}
    {@const liveId = line.liveId}
    <p
      class="flex items-center gap-1.5 font-semibold {verified
        ? 'text-green-600'
        : 'text-amber-600'}"
      data-moderation-chat-line-integrity={line.integrity.content}
    >
      {#if verified}
        <ShieldCheck size={12} class="shrink-0" />
      {:else}
        <ShieldAlert size={12} class="shrink-0" />
      {/if}
      {verdictText[line.integrity.content]?.() ?? line.integrity.content}
    </p>
    <div class="text-text-muted flex items-center gap-1.5">
      <span>{m.moderation_chat_line_live_label()}</span>
      <button
        type="button"
        onclick={() => void copyId(liveId)}
        class="text-text-muted/50 hover:text-text-muted text-2xs flex items-center gap-1 font-mono transition-colors"
        title={m.admin_copy_id_label()}
        data-moderation-chat-line-live
      >
        {liveId}
        <Copy size={10} />
      </button>
    </div>
  {:else}
    <p class="text-text-muted italic" data-moderation-chat-line-erased>
      {m.moderation_chat_line_erased()}
    </p>
  {/if}
</div>

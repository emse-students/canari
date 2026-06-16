<script lang="ts">
  import { shortenReplyPreview } from '$lib/utils/chat/messageDisplay';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** ID of the quoted message, used for scroll-to navigation. */
    replyId?: string;
    /** User ID of the quoted message's author. */
    senderId: string;
    /** Pre-resolved display name of the quoted message's author. */
    displayName: string;
    /** Raw content of the quoted message (will be shortened automatically). */
    content: string;
    /** Called when the user clicks the quote to navigate to the original message. */
    onNavigateToMessage?: (id: string) => void;
  }

  let { replyId, senderId, displayName, content, onNavigateToMessage }: Props = $props();

  const previewText = $derived(shortenReplyPreview(content));
</script>

<button
  type="button"
  class="mb-2 pt-2 pb-2 border-l-4 border-current/60 pl-3.5 text-xs opacity-95 text-left w-full hover:opacity-100 transition-opacity rounded-r-lg bg-black/5 dark:bg-white/5"
  onclick={(e) => {
    e.stopPropagation();
    if (replyId) onNavigateToMessage?.(replyId);
  }}
  title={m.msg_go_to_quoted_message_label()}
  aria-label={m.msg_go_to_quoted_message_label()}
>
  <a
    href="/profile/{encodeURIComponent(senderId)}"
    class="font-bold truncate hover:underline"
    onclick={(e) => e.stopPropagation()}>{displayName}</a
  >
  <div class="truncate mt-0.5">{previewText}</div>
</button>

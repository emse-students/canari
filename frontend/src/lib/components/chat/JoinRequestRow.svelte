<script lang="ts">
  import { UserPlus } from '@lucide/svelte';
  import { pendingJoinRequests, canAnswerJoinRequests } from '$lib/utils/chat/joinRequests.svelte';
  import { answerJoinRequestOrToast } from '$lib/utils/chat/joinRequestAnswer';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';
  import type { JoinRequest } from '$lib/utils/chat/joinRequests.svelte';

  interface Props {
    /** The MLS group id of the conversation this thread belongs to. */
    groupId: string;
  }
  let { groupId }: Props = $props();

  /**
   * THE ASK OF A NEW PERSON, AT THE END OF THE THREAD IT IS ABOUT (`joinRequests.svelte.ts`).
   *
   * A card that follows the ask rather than a persisted system row: the ask is state of this session
   * (the server's pending seats, read by each sweep), so a stored row would outlive it - and keep
   * Add and Decline on screen for someone another member already admitted. Derived from the store,
   * it leaves with the ask. It is drawn only while something can answer it, so a tap never lands on
   * nothing; the global banner shows the asks of the other conversations.
   *
   * Any member may add them: the Add is this device's own, and only one device wins the add lock.
   */
  const asks = $derived(
    canAnswerJoinRequests() ? pendingJoinRequests().filter((r) => r.groupId === groupId) : []
  );
  let busy = $state(false);

  async function answer(request: JoinRequest, choice: 'approve' | 'decline') {
    busy = true;
    try {
      await answerJoinRequestOrToast(request, choice);
    } finally {
      busy = false;
    }
  }
</script>

{#each asks as request (request.userId)}
  <div
    class="my-3 flex justify-center"
    role="group"
    aria-label={m.join_request_title()}
    data-join-request={request.userId}
  >
    <div
      class="bg-cn-surface border-cn-border text-text-main flex max-w-[90%] flex-col items-center gap-2 rounded-2xl border px-4 py-3 text-center text-xs shadow-sm"
    >
      <span class="inline-flex items-center gap-2 font-semibold">
        <UserPlus size={14} class="shrink-0" aria-hidden="true" />
        {m.join_request_row_text({ user: getUserDisplayNameSync(request.userId) })}
      </span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-3 py-1.5 font-bold transition-colors disabled:opacity-50"
          disabled={busy}
          onclick={() => answer(request, 'approve')}>{m.join_request_accept()}</button
        >
        <button
          type="button"
          class="border-cn-border hover:bg-cn-bg rounded-xl border px-3 py-1.5 font-semibold disabled:opacity-50"
          disabled={busy}
          onclick={() => answer(request, 'decline')}>{m.join_request_decline()}</button
        >
      </div>
    </div>
  </div>
{/each}

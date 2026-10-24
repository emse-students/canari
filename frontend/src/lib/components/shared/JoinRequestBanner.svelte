<script lang="ts">
  import { UserPlus } from '@lucide/svelte';
  import Banner from './Banner.svelte';
  import { globalConvs, globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import {
    answerJoinRequest,
    canAnswerJoinRequests,
    pendingJoinRequests,
    type JoinRequest,
  } from '$lib/utils/chat/joinRequests.svelte';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * A new person asking to join a group conversation this account is in (`joinRequests.svelte.ts`).
   *
   * An automatic Add never admits a new person - a server row or a relayed request is not a member's
   * decision - so the ask is put to the member here: accepting is this device's own Add; declining
   * asks the server to withdraw the person's seat, which it does ONLY while that seat still awaits a
   * member - a person another member's Add admitted first is left whole (`declineJoinRequest`). One
   * ask at a time, the oldest first; it stays until answered, or until a sweep finds another member
   * answered it - and it is shown only while the chat page that answers it is mounted.
   */
  const request = $derived(
    session.isLoggedIn && canAnswerJoinRequests() ? pendingJoinRequests()[0] : undefined
  );
  const groupName = $derived(
    request ? (globalConvs.conversations.get(request.groupId)?.name ?? '') : ''
  );
  let busy = $state(false);

  async function answer(target: JoinRequest, choice: 'approve' | 'decline') {
    busy = true;
    try {
      if (!(await answerJoinRequest(target, choice))) showToast(m.join_request_failed(), 'error');
    } finally {
      busy = false;
    }
  }
</script>

{#if request}
  <Banner variant="info" tone="alert">
    <UserPlus size={15} class="shrink-0" aria-hidden="true" />
    <div class="flex min-w-0 flex-col">
      <strong>{m.join_request_title()}</strong>
      <span>
        {groupName
          ? m.join_request_body_named({
              user: getUserDisplayNameSync(request.userId),
              group: groupName,
            })
          : m.join_request_body({ user: getUserDisplayNameSync(request.userId) })}
      </span>
    </div>
    {#snippet action()}
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="font-semibold"
          disabled={busy}
          onclick={() => answer(request, 'approve')}>{m.join_request_accept()}</button
        >
        <button
          type="button"
          class="font-semibold"
          disabled={busy}
          onclick={() => answer(request, 'decline')}>{m.join_request_decline()}</button
        >
      </div>
    {/snippet}
  </Banner>
{/if}

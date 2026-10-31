<script lang="ts">
  import { Info } from '@lucide/svelte';
  import {
    pendingJoinRequests,
    declinedJoinRequests,
    canAnswerJoinRequests,
    isOwnDeviceAsk,
  } from '$lib/utils/chat/joinRequests.svelte';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import { answerJoinRequestOrToast, deviceAskDetail } from '$lib/utils/chat/joinRequestAnswer';
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
   * A DISCREET SYSTEM LINE, drawn like the conversation's other notices ("X added Y") with two small
   * inline answers - never a banner, never app-wide (owner, 2026-10-30). An accepted ask is followed
   * by the ordinary `memberAdded` notice every member's device writes; a decline leaves a line here,
   * on the declining member's device only, since no frame tells the others.
   *
   * It follows the ask rather than being a persisted system row: the ask is state of this session
   * (the server's pending seats, read by each sweep), so a stored row would outlive it - and keep
   * the answers on screen for someone another member already admitted. Derived from the store, it
   * leaves with the ask. It is drawn only while something can answer it, so a tap never lands on
   * nothing.
   *
   * Any member may add them: the Add is this device's own, and only one device wins the add lock.
   * A device never seen here, of a user already in the conversation (`kind: 'device'`), is told in
   * its own words, one line per device; its key fingerprint sits behind "Details", and its answer is
   * about that device alone (`memberDeviceAnswers.ts`).
   */
  const asks = $derived(
    canAnswerJoinRequests() ? pendingJoinRequests().filter((r) => r.groupId === groupId) : []
  );
  const declinedLines = $derived(declinedJoinRequests(groupId));
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

{#each asks as request (`${request.kind ?? 'person'}|${request.userId}|${request.kind === 'device' ? request.deviceIds[0] : ''}`)}
  {@const detail = deviceAskDetail(request)}
  <div
    class="my-3 flex justify-center"
    role="group"
    aria-label={m.join_request_title()}
    data-join-request={request.userId}
    data-join-request-kind={request.kind ?? 'person'}
  >
    <div
      class="text-text-muted inline-flex max-w-md flex-col items-center gap-1 rounded-xl border border-black/5 bg-black/5 px-3.5 py-1.5 text-center text-xs font-medium shadow-sm dark:border-white/10 dark:bg-white/5"
    >
      <span class="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        <Info size={14} class="shrink-0 opacity-60" aria-hidden="true" />
        <span>
          {#if request.kind !== 'device'}
            {m.join_request_row_text({ user: getUserDisplayNameSync(request.userId) })}
          {:else if isOwnDeviceAsk(request, session.userId)}
            {m.join_request_device_row_text_own()}
          {:else}
            {m.join_request_device_row_text({ user: getUserDisplayNameSync(request.userId) })}
          {/if}
        </span>
        <span class="text-text-main inline-flex items-center gap-2 font-semibold">
          <button
            type="button"
            class="underline underline-offset-2 disabled:opacity-50"
            disabled={busy}
            data-join-answer="approve"
            onclick={() => answer(request, 'approve')}
            >{request.kind === 'device'
              ? m.join_request_device_add()
              : m.join_request_accept()}</button
          >
          <button
            type="button"
            class="underline underline-offset-2 disabled:opacity-50"
            disabled={busy}
            data-join-answer="decline"
            onclick={() => answer(request, 'decline')}>{m.join_request_decline()}</button
          >
        </span>
      </span>
      {#if detail}
        <details>
          <summary class="cursor-pointer">{m.join_request_details()}</summary>
          <span class="font-mono" data-device-ask-detail>{detail}</span>
        </details>
      {/if}
    </div>
  </div>
{/each}

<!-- The member's own declines, said here only: no frame carries a decline to the other members. -->
{#each declinedLines as line (line.key)}
  <div class="my-3 flex justify-center" data-join-declined={line.userId}>
    <div
      class="text-text-muted inline-flex max-w-md items-center gap-2 rounded-xl border border-black/5 bg-black/5 px-3.5 py-1.5 text-center text-xs font-medium shadow-sm dark:border-white/10 dark:bg-white/5"
    >
      <Info size={14} class="shrink-0 opacity-60" aria-hidden="true" />
      <span>
        {line.kind === 'device'
          ? m.join_request_device_declined_line({ user: getUserDisplayNameSync(line.userId) })
          : m.join_request_declined_line({ user: getUserDisplayNameSync(line.userId) })}
      </span>
    </div>
  </div>
{/each}

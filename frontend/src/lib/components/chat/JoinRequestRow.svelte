<script lang="ts">
  import { Info } from '@lucide/svelte';
  import {
    pendingJoinRequests,
    declinedJoinRequests,
    canAnswerJoinRequests,
  } from '$lib/utils/chat/joinRequests.svelte';
  import { answerJoinRequestOrToast } from '$lib/utils/chat/joinRequestAnswer';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { SvelteMap } from 'svelte/reactivity';
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
   * ONLY A PERSON IS EVER ASKED ABOUT (owner, 2026-10-31): a new device of a member is added by
   * itself, and the conversation says "X added a device" instead (`deviceNotices.svelte.ts`).
   */
  const asks = $derived(
    canAnswerJoinRequests() ? pendingJoinRequests().filter((r) => r.groupId === groupId) : []
  );
  const declinedLines = $derived(declinedJoinRequests(groupId));
  let busy = $state(false);

  /**
   * THE NAMES RESOLVED FOR THE PEOPLE ON SCREEN. An outsider who came by link is exactly the person
   * no name cache holds, and `getUserDisplayNameSync` reads that cache without notifying anyone: the
   * line used to say "Utilisateur inconnu" for good. So each person is resolved once, when their ask
   * (or decline line) appears, and the answer is held here, REACTIVELY, so the line redraws.
   */
  const resolvedNames = new SvelteMap<string, string>();
  const asked = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- a request ledger, nothing renders it

  $effect(() => {
    for (const userId of [...asks, ...declinedLines].map((r) => r.userId)) {
      if (asked.has(userId)) continue;
      asked.add(userId);
      void resolveUserDisplayName(userId)
        .then((name) => {
          if (name) resolvedNames.set(userId, name);
        })
        .catch((e: unknown) => {
          // Not a defect of the card: the line keeps the placeholder, and the next ask retries.
          asked.delete(userId);
          console.warn(`[JOIN_REQUEST] name of ${userId} not resolved: ${String(e)}`);
        });
    }
  });

  const nameOf = (userId: string) => resolvedNames.get(userId) ?? getUserDisplayNameSync(userId);
  /** The sentence split around the name, so the name can be a link to the profile. */
  const NAME_SLOT = '\u0001';
  const rowText = $derived(m.join_request_row_text({ user: NAME_SLOT }).split(NAME_SLOT));
  const textBefore = $derived(rowText[0] ?? '');
  const textAfter = $derived(rowText[1] ?? '');

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
      class="text-text-muted inline-flex max-w-md flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-xl border border-black/5 bg-black/5 px-3.5 py-1.5 text-center text-xs font-medium shadow-sm dark:border-white/10 dark:bg-white/5"
    >
      <Info size={14} class="shrink-0 opacity-60" aria-hidden="true" />
      <span
        >{textBefore}<a
          href="/profile/{encodeURIComponent(request.userId)}"
          class="text-text-main underline underline-offset-2"
          data-join-profile={request.userId}>{nameOf(request.userId)}</a
        >{textAfter}</span
      >
      <span class="text-text-main inline-flex items-center gap-2 font-semibold">
        <button
          type="button"
          class="underline underline-offset-2 disabled:opacity-50"
          disabled={busy}
          data-join-answer="approve"
          onclick={() => answer(request, 'approve')}>{m.join_request_accept()}</button
        >
        <button
          type="button"
          class="underline underline-offset-2 disabled:opacity-50"
          disabled={busy}
          data-join-answer="decline"
          onclick={() => answer(request, 'decline')}>{m.join_request_decline()}</button
        >
      </span>
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
      <span>{m.join_request_declined_line({ user: nameOf(line.userId) })}</span>
    </div>
  </div>
{/each}

<script lang="ts">
  /**
   * THE AUTHOR'S INBOX OF REPUBLICATION REQUESTS (D38b).
   *
   * An association asks the author of a personal post to let it carry the post; the author alone
   * answers, here. Nothing is shown to the association's readers before they accept, and they can
   * withdraw the republication at any time afterwards from the post's own menu.
   *
   * Each row states plainly what accepting means, as the decision requires: WHO asks (the member who
   * pressed the button), in WHICH association's name, about WHICH post, and HOW MANY readers would
   * see it for the first time - a count, never their names. A row leaves the list on the server's
   * answer; a 409 means it was already decided or withdrawn, and the list is re-read.
   */
  import { onMount } from 'svelte';
  import { Inbox } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import {
    acceptProposal,
    listMyRepublicationRequests,
    PROPOSAL_SENDER_GONE,
    refuseProposal,
    type RepublicationRequest,
  } from '$lib/proposals/api';
  import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
  import { formatRelative } from '$lib/utils/time';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  let requests = $state<RepublicationRequest[]>([]);
  let loading = $state(true);
  let errorMessage = $state('');
  /** The request whose answer is in flight, so no button can be pressed twice. */
  let busy = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    errorMessage = '';
    try {
      requests = (await listMyRepublicationRequests()).incoming;
      Log.d('RepublicationRequests', `loaded ${requests.length}`);
    } catch (e: unknown) {
      Log.d('RepublicationRequests', `load failed: ${String(e)}`);
      errorMessage = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  /** Accepts or refuses one request; the row leaves the list on the server's answer. */
  async function answer(request: RepublicationRequest, action: 'accept' | 'refuse') {
    busy = request.id;
    errorMessage = '';
    Log.d('RepublicationRequests', `${action} request=${request.id.slice(0, 8)}`);
    try {
      if (action === 'accept') await acceptProposal(request.id);
      else await refuseProposal(request.id);
      requests = requests.filter((r) => r.id !== request.id);
      showToast(
        action === 'accept'
          ? m.republication_requests_accepted()
          : m.republication_requests_refused(),
        'info'
      );
    } catch (e: unknown) {
      const status = refusalStatus(e);
      Log.d('RepublicationRequests', `${action} refused: status=${status} ${String(e)}`);
      if (status === 409) {
        // Re-read FIRST: `load` clears the message, and the reason is what this answer must show.
        await load();
        errorMessage =
          refusalCode(e) === PROPOSAL_SENDER_GONE
            ? m.republication_requests_sender_gone()
            : m.asso_republications_not_pending();
      } else {
        errorMessage = m.post_republish_error();
      }
    } finally {
      busy = null;
    }
  }
</script>

<PageContainer>
  <PageHeader
    title={m.republication_requests_title()}
    subtitle={m.republication_requests_subtitle()}
    backHref="/notifications"
    backLabel={m.nav_notifications_label()}
  />

  {#if errorMessage}
    <div
      class="border-red-err/30 bg-red-err/10 text-red-err mb-3 rounded-xl border px-4 py-3 text-sm"
    >
      {errorMessage}
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-6">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if requests.length === 0}
    <div class="text-text-muted flex flex-col items-center gap-3 py-16">
      <Inbox size={40} strokeWidth={1.5} class="opacity-40" />
      <p class="text-sm">{m.republication_requests_empty()}</p>
    </div>
  {:else}
    <ul class="space-y-3">
      {#each requests as request (request.id)}
        <li class="border-cn-border bg-cn-surface space-y-2 rounded-xl border p-4">
          <div class="flex items-center gap-2">
            <AssociationAvatar
              id={request.from.id}
              name={request.from.name}
              logoUrl={request.from.logoUrl}
              size="sm"
              shape="circle"
            />
            <span class="text-text-main min-w-0 flex-1 text-sm font-semibold">
              {request.proposedBy?.name
                ? m.republication_requests_line({
                    person: request.proposedBy.name,
                    association: request.from.name,
                  })
                : m.republication_requests_line_no_person({ association: request.from.name })}
            </span>
            <span class="text-text-muted shrink-0 text-xs">
              {formatRelative(request.createdAt)}
            </span>
          </div>
          {#if request.details}
            <p class="text-text-main line-clamp-3 text-sm italic">
              <EmojiText text={request.details.preview} />
            </p>
            <p class="text-text-muted text-xs">
              {m.republication_requests_reach({ count: request.details.newlyReached })}
            </p>
            <a
              href="/posts/{encodeURIComponent(request.subjectId)}"
              class="text-xs font-semibold text-amber-600 hover:underline dark:text-amber-400"
            >
              {m.asso_republications_view_post()}
            </a>
          {:else}
            <p class="text-text-muted text-sm italic">{m.asso_republications_subject_gone()}</p>
          {/if}
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5 disabled:opacity-40"
              disabled={busy !== null}
              onclick={() => answer(request, 'refuse')}
            >
              {m.republication_requests_refuse()}
            </button>
            <button
              type="button"
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-40"
              disabled={busy !== null || !request.details}
              onclick={() => answer(request, 'accept')}
            >
              {m.republication_requests_accept()}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</PageContainer>

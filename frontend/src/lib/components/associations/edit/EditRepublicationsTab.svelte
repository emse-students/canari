<script lang="ts">
  /**
   * THE PROPOSAL QUEUE OF ONE ASSOCIATION (D38): what other associations sent it to republish, and
   * what it sent and still waits on.
   *
   * A pending proposal never expires (user, 2026-10-04): it waits here until this association
   * accepts or refuses it, or its sender withdraws it. Accepting republishes the post at once, and
   * its newly reached readers are notified by the server. A row this tab decides leaves the list on
   * the server's answer; a 409 means someone else decided first, and the queue is re-read.
   */
  import { onMount } from 'svelte';
  import { Repeat2 } from '@lucide/svelte';
  import type { Association } from '$lib/associations/api';
  import {
    acceptProposal,
    listPendingProposals,
    refuseProposal,
    withdrawProposal,
    type Proposal,
  } from '$lib/proposals/api';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { formatRelative } from '$lib/utils/time';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
  }

  let { asso }: Props = $props();

  let incoming = $state<Proposal[]>([]);
  let outgoing = $state<Proposal[]>([]);
  let loading = $state(false);
  let errorMessage = $state('');
  /** The proposal whose decision is in flight, so its buttons cannot be pressed twice. */
  let busy = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    errorMessage = '';
    try {
      const queue = await listPendingProposals(asso.id);
      incoming = queue.incoming;
      outgoing = queue.outgoing;
    } catch (e: unknown) {
      Log.d('EditRepublicationsTab', `queue load failed: ${String(e)}`);
      errorMessage = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  /** Accept, refuse or withdraw - one write, then the row leaves the list it was in. */
  async function decide(proposal: Proposal, action: 'accept' | 'refuse' | 'withdraw') {
    busy = proposal.id;
    errorMessage = '';
    Log.d('EditRepublicationsTab', `${action} proposal=${proposal.id.slice(0, 8)}`);
    try {
      if (action === 'accept') await acceptProposal(proposal.id);
      else if (action === 'refuse') await refuseProposal(proposal.id);
      else await withdrawProposal(proposal.id);
      incoming = incoming.filter((p) => p.id !== proposal.id);
      outgoing = outgoing.filter((p) => p.id !== proposal.id);
    } catch (e: unknown) {
      const status = refusalStatus(e);
      Log.d('EditRepublicationsTab', `${action} refused: status=${status} ${String(e)}`);
      if (status === 409) {
        errorMessage = m.asso_republications_not_pending();
        await load();
      } else {
        errorMessage = m.post_republish_error();
      }
    } finally {
      busy = null;
    }
  }
</script>

{#snippet subjectLine(proposal: Proposal)}
  {#if proposal.subject}
    <p class="text-text-main line-clamp-3 text-sm italic">
      <EmojiText text={proposal.subject.preview} />
    </p>
    <a
      href="/posts/{encodeURIComponent(proposal.subjectId)}"
      class="text-xs font-semibold text-amber-600 hover:underline dark:text-amber-400"
    >
      {m.asso_republications_view_post()}
    </a>
  {:else}
    <p class="text-text-muted text-sm italic">{m.asso_republications_subject_gone()}</p>
  {/if}
{/snippet}

<div class="border-cn-border bg-cn-surface space-y-6 rounded-2xl border p-6 shadow-sm">
  <div>
    <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
      <Repeat2 size={20} />
      {m.asso_republications_title()}
    </h2>
    <p class="text-text-muted mt-1 text-sm">{m.asso_republications_subtitle()}</p>
  </div>

  {#if errorMessage}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {errorMessage}
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-6">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    <section class="space-y-3">
      <h3 class="text-text-main text-sm font-bold">{m.asso_republications_incoming()}</h3>
      {#if incoming.length === 0}
        <p class="text-text-muted text-sm">{m.asso_republications_empty_incoming()}</p>
      {:else}
        <ul class="space-y-3">
          {#each incoming as proposal (proposal.id)}
            <li class="border-cn-border space-y-2 rounded-xl border p-4">
              <div class="flex items-center gap-2">
                <AssociationAvatar
                  name={proposal.from.name}
                  logoUrl={proposal.from.logoUrl}
                  size="sm"
                  shape="circle"
                />
                <span class="text-text-main min-w-0 truncate text-sm font-semibold">
                  {m.asso_republications_from({ name: proposal.from.name })}
                </span>
                <span class="text-text-muted ml-auto shrink-0 text-xs">
                  {formatRelative(proposal.createdAt)}
                </span>
              </div>
              {@render subjectLine(proposal)}
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5 disabled:opacity-40"
                  disabled={busy !== null}
                  onclick={() => decide(proposal, 'refuse')}
                >
                  {m.asso_republications_refuse()}
                </button>
                <button
                  type="button"
                  class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-40"
                  disabled={busy !== null || !proposal.subject}
                  onclick={() => decide(proposal, 'accept')}
                >
                  {m.asso_republications_accept()}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="space-y-3">
      <h3 class="text-text-main text-sm font-bold">{m.asso_republications_outgoing()}</h3>
      {#if outgoing.length === 0}
        <p class="text-text-muted text-sm">{m.asso_republications_empty_outgoing()}</p>
      {:else}
        <ul class="space-y-3">
          {#each outgoing as proposal (proposal.id)}
            <li class="border-cn-border space-y-2 rounded-xl border p-4">
              <div class="flex items-center gap-2">
                <AssociationAvatar
                  name={proposal.to.name}
                  logoUrl={proposal.to.logoUrl}
                  size="sm"
                  shape="circle"
                />
                <span class="text-text-main min-w-0 truncate text-sm font-semibold">
                  {m.asso_republications_to({ name: proposal.to.name })}
                </span>
                <span class="text-text-muted ml-auto shrink-0 text-xs">
                  {formatRelative(proposal.createdAt)}
                </span>
              </div>
              {@render subjectLine(proposal)}
              <div class="flex justify-end">
                <button
                  type="button"
                  class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5 disabled:opacity-40"
                  disabled={busy !== null}
                  onclick={() => decide(proposal, 'withdraw')}
                >
                  {m.asso_republications_withdraw()}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

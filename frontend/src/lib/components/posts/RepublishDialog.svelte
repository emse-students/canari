<script lang="ts">
  /**
   * REPUBLISH OR PROPOSE (D38): pick an association, and the post reaches its audience too.
   *
   * Two modes, one list, because they are one gesture aimed at two kinds of association:
   * - `republish` - one the reader publishes in the name of. The republication is immediate.
   * - `propose` - any other association. It lands in that association's queue, where its
   *   publishers accept or refuse it (`$lib/proposals/api`).
   *
   * The lists are what is OFFERED (`$lib/posts/republication`); the server checks every choice again,
   * and its 409 (already carried, already proposed) is read by STATUS, never by message.
   */
  import Modal from '$lib/components/shared/Modal.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { listAssociations, listMyAssociations, type Association } from '$lib/associations/api';
  import { proposeRepublication, republishPost, type PostEntity } from '$lib/posts/api';
  import { proposalCandidates, republishCandidates } from '$lib/posts/republication';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Which dialog is open, or `null` for closed. */
    mode: 'republish' | 'propose' | null;
    /** The post being republished or proposed. */
    post: PostEntity;
    onClose: () => void;
    /** Called after the server accepted the write, with the association chosen. */
    onDone: (mode: 'republish' | 'propose', association: Association) => void;
  }

  let { mode, post, onClose, onDone }: Props = $props();

  let candidates = $state<Association[]>([]);
  let loading = $state(false);
  let loadFailed = $state(false);
  let selected = $state<string | null>(null);
  let query = $state('');
  let submitting = $state(false);
  let errorMessage = $state('');

  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter((a) => a.name.toLowerCase().includes(q)) : candidates;
  });

  // Each opening reloads its own list and forgets the previous choice: the two modes offer
  // different associations, and a republication made meanwhile changes both.
  $effect(() => {
    if (!mode) return;
    const opened = mode;
    selected = null;
    query = '';
    errorMessage = '';
    loadFailed = false;
    loading = true;
    let cancelled = false;
    const load =
      opened === 'republish'
        ? (isGlobalAdmin() ? listAssociations() : listMyAssociations()).then((mine) =>
            republishCandidates(mine, post, isGlobalAdmin())
          )
        : listAssociations().then((all) => proposalCandidates(all, post));
    load
      .then((list) => {
        if (!cancelled) candidates = list;
      })
      .catch((e: unknown) => {
        Log.d('RepublishDialog', `candidate list failed (${opened}): ${String(e)}`);
        if (!cancelled) loadFailed = true;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  async function submit() {
    const chosen = candidates.find((a) => a.id === selected);
    if (!mode || !chosen) return;
    const acting = mode;
    submitting = true;
    errorMessage = '';
    Log.d('RepublishDialog', `${acting} post=${post.id.slice(0, 8)} as=${chosen.id.slice(0, 8)}`);
    try {
      if (acting === 'republish') await republishPost(post.id, chosen.id);
      else await proposeRepublication(post.id, chosen.id);
      showToast(acting === 'republish' ? m.post_republish_done() : m.post_propose_done(), 'info');
      onDone(acting, chosen);
    } catch (e: unknown) {
      const status = refusalStatus(e);
      Log.d('RepublishDialog', `${acting} refused: status=${status} ${String(e)}`);
      errorMessage = status === 409 ? m.post_republish_conflict() : m.post_republish_error();
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  open={mode !== null}
  {onClose}
  title={mode === 'propose' ? m.post_propose_dialog_title() : m.post_republish_dialog_title()}
  maxWidth="max-w-sm"
  dismissible={!submitting}
>
  <div class="space-y-4 px-1 pb-2">
    <p class="text-text-muted text-sm">
      {mode === 'propose' ? m.post_propose_dialog_hint() : m.post_republish_dialog_hint()}
    </p>

    {#if candidates.length > 6}
      <input
        type="search"
        bind:value={query}
        placeholder={m.post_republish_search_placeholder()}
        class="border-cn-border text-text-main w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
      />
    {/if}

    {#if loading}
      <div class="flex justify-center py-4">
        <div
          class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if loadFailed}
      <p class="text-red-err text-sm">{m.common_load_error()}</p>
    {:else if visible.length === 0}
      <p class="text-text-muted py-2 text-sm">{m.post_republish_no_candidate()}</p>
    {:else}
      <div class="max-h-72 space-y-2 overflow-y-auto">
        {#each visible as a (a.id)}
          <button
            type="button"
            class="border-cn-border text-text-main flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors hover:border-amber-400 disabled:opacity-40 {selected ===
            a.id
              ? 'border-amber-400 bg-amber-400/10'
              : ''}"
            aria-pressed={selected === a.id}
            onclick={() => (selected = a.id)}
            disabled={submitting}
          >
            <AssociationAvatar name={a.name} logoUrl={a.logoUrl} size="sm" shape="circle" />
            <span class="truncate">{a.name}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if errorMessage}
      <p class="text-red-err text-sm">{errorMessage}</p>
    {/if}

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
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-40"
        onclick={submit}
        disabled={submitting || !selected}
      >
        {mode === 'propose' ? m.post_propose_submit() : m.post_republish_submit()}
      </button>
    </div>
  </div>
</Modal>

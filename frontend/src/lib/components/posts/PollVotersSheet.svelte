<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { resolvePollVoters, type PollVoter } from '$lib/posts/pollVoters';
  import { m } from '$lib/paraglide/messages';

  /**
   * The FULL list of who voted for an option: a bottom sheet on a phone, a centred dialog on a
   * desktop (`Modal` decides, and brings the focus trap, Escape and the back gesture).
   *
   * It exists because the hover tooltip cannot be reached on a touch screen without a long press,
   * which is hard to hold without voting, and cannot hold 45 names (user, 2026-10-24). Opening it is
   * a tap on a button that is a SIBLING of the vote button, never a child: nothing in here can cast
   * a vote. An anonymous poll never reaches it - the server sends it no voter ids.
   */
  interface Props {
    /** The options of ONE poll, each with the ids that voted for it. */
    options: { id: string; label: string; voterIds: string[] }[];
    /** The option shown first. */
    initialOptionId: string;
    onClose: () => void;
  }

  let { options, initialOptionId, onClose }: Props = $props();

  // svelte-ignore state_referenced_locally -- the sheet opens on this option; the tabs move it after
  let activeId = $state(initialOptionId);
  const active = $derived(options.find((o) => o.id === activeId) ?? options[0]);
  let names = $state<Record<string, PollVoter[]>>({});

  $effect(() => {
    const opt = active;
    if (!opt || names[opt.id]) return;
    void resolvePollVoters(opt.voterIds).then((rows) => (names = { ...names, [opt.id]: rows }));
  });

  /** Arrow keys move between the option tabs, as a tablist does. */
  function onTabKeydown(e: KeyboardEvent, index: number) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(index + step + options.length) % options.length];
    activeId = next.id;
    queueMicrotask(() => document.getElementById(`poll-voters-tab-${next.id}`)?.focus());
  }
</script>

<Modal open title={m.post_poll_voters_label()} maxWidth="max-w-md" {onClose}>
  {#if options.length > 1}
    <div
      role="tablist"
      aria-label={m.post_poll_voters_options_label()}
      class="-mx-2 mb-3 flex gap-2 overflow-x-auto px-2 pb-1"
    >
      {#each options as opt, i (opt.id)}
        <button
          type="button"
          role="tab"
          id="poll-voters-tab-{opt.id}"
          aria-selected={opt.id === active.id}
          aria-controls="poll-voters-panel"
          tabindex={opt.id === active.id ? 0 : -1}
          class="min-h-11 max-w-[11rem] shrink-0 truncate rounded-full border px-3 text-xs font-semibold transition-colors {opt.id ===
          active.id
            ? 'text-text-main border-amber-500 bg-amber-500/10'
            : 'border-cn-border text-text-muted'}"
          onclick={() => (activeId = opt.id)}
          onkeydown={(e) => onTabKeydown(e, i)}
        >
          {opt.label} ({opt.voterIds.length})
        </button>
      {/each}
    </div>
  {/if}

  <div
    id="poll-voters-panel"
    role={options.length > 1 ? 'tabpanel' : undefined}
    aria-labelledby={options.length > 1 ? `poll-voters-tab-${active.id}` : undefined}
  >
    <p class="text-text-main mb-2 text-sm font-bold">
      <EmojiText text={active.label} />
      <span class="text-text-muted text-xs font-semibold">
        - {m.post_poll_vote_count_label({ count: active.voterIds.length })}
      </span>
    </p>
    {#if active.voterIds.length === 0}
      <p class="text-text-muted text-sm italic">{m.post_poll_voters_none()}</p>
    {:else if names[active.id]}
      <ul class="divide-cn-border/60 divide-y" data-testid="poll-voters-list">
        {#each names[active.id] as voter (voter.id)}
          <li class="text-text-main py-2 text-sm">{voter.name}</li>
        {/each}
      </ul>
    {:else}
      <p class="text-text-muted text-sm italic">{m.common_loading_label()}</p>
    {/if}
  </div>
</Modal>

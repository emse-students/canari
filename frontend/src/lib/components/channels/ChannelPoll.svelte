<script lang="ts">
  import PostPolls from '$lib/components/posts/PostPolls.svelte';
  import type { Poll } from '$lib/posts/api';
  import type { ChannelPollMeta, ChannelPollSpec } from '$lib/services/ChannelService';

  /**
   * Renders a community poll inline as a rich card by reusing the post poll
   * presentation ({@link PostPolls}). The poll's question/labels come from the
   * decrypted message (`spec`); the live tally comes from the server-side
   * {@link ChannelPollMeta}. The component owns the local selection and emits the
   * final choice through {@link Props.onVote} - the API call lives in the parent.
   */
  interface Props {
    /** Decrypted poll definition (question + option labels). */
    spec: ChannelPollSpec;
    /** Server-side poll state (votesByUser, deadline). */
    meta: ChannelPollMeta;
    /** Current user, used to highlight their selection. */
    currentUserId: string;
    /** Called with the full selection when the user votes (empty = retract). */
    onVote?: (optionIds: string[]) => void | Promise<void>;
  }

  let { spec, meta, currentUserId, onVote }: Props = $props();

  // Per-option voter lists derived from votesByUser, so PostPolls can show counts.
  const votersByOption = $derived.by(() => {
    const map: Record<string, string[]> = {};
    for (const opt of spec.options) map[opt.id] = [];
    for (const [uid, ids] of Object.entries(meta.votesByUser ?? {})) {
      for (const id of ids) (map[id] ??= []).push(uid);
    }
    return map;
  });

  const poll = $derived<Poll>({
    id: 'channel-poll',
    question: spec.question,
    options: spec.options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: votersByOption[o.id] ?? [],
    })),
    multipleChoice: meta.multipleChoice,
    endsAt: meta.endsAt ?? undefined,
    votesByUser: meta.votesByUser ?? {},
  });

  // Writable derived: re-syncs from the server tally when it changes, but stays
  // reassignable so the user can toggle options before submitting.
  let selectedOptions = $derived<string[]>([...(meta.votesByUser?.[currentUserId] ?? [])]);

  const isClosed = $derived(!!meta.endsAt && new Date(meta.endsAt).getTime() <= Date.now());

  /**
   * Single-choice: toggle then submit immediately. Multiple-choice: just toggle;
   * the user submits via the "Voter" button (onSubmitVote). Mirrors PostCard.
   */
  function handleVoteClick(_pollId: string, optionId: string, multipleChoice: boolean) {
    if (isClosed) return;
    if (!multipleChoice) {
      selectedOptions = selectedOptions.includes(optionId) ? [] : [optionId];
      void onVote?.(selectedOptions);
    } else if (selectedOptions.includes(optionId)) {
      selectedOptions = selectedOptions.filter((id) => id !== optionId);
    } else {
      selectedOptions = [...selectedOptions, optionId];
    }
  }

  function submitVote() {
    if (isClosed) return;
    void onVote?.(selectedOptions);
  }
</script>

<PostPolls
  polls={[poll]}
  {selectedOptions}
  onVoteClick={handleVoteClick}
  onSubmitVote={submitVote}
/>

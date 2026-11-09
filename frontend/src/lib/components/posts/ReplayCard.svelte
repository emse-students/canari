<script lang="ts">
  /**
   * A LIVE REPLAY IN THE FEED (docs/wiki/live-replays.md section 5, WP-R4): a card that SAYS WHAT IT
   * IS - the "Rediffusion" mark, its length, the live's title (or "Rediffusion du direct de X") - and
   * plays NOTHING inline: a replay is minutes long and its player needs a MediaSource, so a tap opens
   * the CanaReels viewer on it (`onOpen`), where it plays like a reel.
   *
   * There is no cover picture yet: the live's last preview is not part of what the server serves with
   * a replay (owed), so the card is the dark box a reel waits in, never a guessed image. The time left
   * is NOT drawn here: the feed rows carry no server clock and the phone's would be a guess - the
   * viewer draws it from the replay route's own pair of database times.
   */
  import { History, Play } from '@lucide/svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { formatLiveElapsed } from '$lib/live/openLives';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    post: PostEntity;
    onOpen: () => void;
  }

  let { post, onOpen }: Props = $props();

  const duration = $derived(
    post.durationMs && post.durationMs > 0 ? formatLiveElapsed(post.durationMs) : null
  );
  /** The live's title is the post's caption, drawn above by the post's own text: the card names it only when there is none. */
  const fallbackTitle = $derived(
    post.markdown?.trim() ? null : m.replay_card_default_title({ name: postAuthorName(post) })
  );
</script>

<div class="w-full px-4 pb-3 {post.markdown ? '' : 'pt-2'}">
  <button
    type="button"
    class="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl bg-black text-white outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    aria-label={m.replay_card_open()}
    onclick={() => {
      console.debug(`[LIVE_REPLAY] card ${post.id} opened`);
      onOpen();
    }}
    data-replay-card
  >
    <span
      class="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-bold"
      data-replay-card-badge
    >
      <History size={13} strokeWidth={2.5} aria-hidden="true" />
      {m.replay_badge()}
    </span>
    <span class="flex size-14 items-center justify-center rounded-full bg-white/20">
      <Play size={28} strokeWidth={2.25} class="translate-x-0.5 fill-white" aria-hidden="true" />
    </span>
    {#if fallbackTitle}
      <span
        class="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-black/70 to-transparent px-3 pt-6 pr-16 pb-2 text-left text-sm font-semibold"
        data-replay-card-title>{fallbackTitle}</span
      >
    {/if}
    {#if duration}
      <span
        class="absolute right-2 bottom-2 rounded-md bg-black/60 px-1.5 py-0.5 text-xs font-semibold tabular-nums"
        aria-label={m.replay_card_duration_label()}
        data-replay-card-duration>{duration}</span
      >
    {/if}
  </button>
</div>

<script lang="ts">
  /**
   * A LIVE REPLAY IN THE FEED (docs/wiki/live-replays.md section 5, WP-R4): a card that SAYS WHAT IT
   * IS - the "Rediffusion" mark, its length, the live's title (or "Rediffusion du direct de X") - and
   * plays NOTHING inline: a replay is minutes long and its player needs a MediaSource, so a tap opens
   * the CanaReels viewer on it (`onOpen`), where it plays like a reel.
   *
   * THE COVER is the live's own last preview image (`poster`, served on the row with the key that
   * opens it and nothing else), loaded like the live's card loaded it (`LivePosterImage`); a live that
   * stored none keeps the dark box a reel waits in, never a guessed image. THE TIME LEFT ("encore
   * 2 j", D3) is computed from the row's own pair of database times (`expiresAt`, `serverNow`) by the
   * viewer's one implementation (`replayTimeLeft`), never from this phone's clock; a row without
   * the server's clock shows none.
   */
  import { History } from '@lucide/svelte';
  import type { PostEntity } from '$lib/posts/api';
  import VideoGlassGlyph from '$lib/components/ui/player/VideoGlassGlyph.svelte';
  import LivePosterImage from '$lib/components/live/LivePosterImage.svelte';
  import { formatLiveElapsed } from '$lib/live/openLives';
  import { replayCoverOf, replayTimeLeft } from '$lib/live/replayTimeline';
  import { replayTimeLeftText } from '$lib/live/replayLabels';
  import type { loadLivePoster } from '$lib/live/livePosterView';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';

  interface Props {
    post: PostEntity;
    onOpen: () => void;
    /** The cover's loader; the real one unless a test hands its own. */
    loadCover?: typeof loadLivePoster;
  }

  let { post, onOpen, loadCover }: Props = $props();

  const cover = $derived(replayCoverOf(post));
  const timeLeft = $derived(
    post.expiresAt && post.serverNow ? replayTimeLeft(post.expiresAt, post.serverNow) : null
  );

  const duration = $derived(
    post.durationMs && post.durationMs > 0 ? formatLiveElapsed(post.durationMs) : null
  );
  /** The live's title is the post's caption, drawn above by the post's own text: the card names it only when there is none. */
  const fallbackTitle = $derived(
    post.markdown?.trim() ? null : m.replay_card_default_title({ name: postAuthorName(post) })
  );
</script>

<div class="w-full px-4 pb-3 {post.markdown ? '' : 'pt-2'}">
  <Button
    type="button"
    variant="ghost"
    class="focus-visible:ring-accent relative aspect-video h-auto min-h-0 w-full overflow-hidden rounded-2xl border-0 bg-black p-0 text-white outline-none hover:bg-black hover:text-white focus-visible:ring-2"
    aria-label={m.replay_card_open()}
    onclick={() => {
      console.debug(`[LIVE_REPLAY] card ${post.id} opened`);
      onOpen();
    }}
    data-replay-card
  >
    {#if cover}
      <span class="absolute inset-0" data-replay-card-cover>
        <LivePosterImage
          live={cover}
          alt={m.replay_cover_alt({ name: postAuthorName(post) })}
          load={loadCover}
          placeholder={false}
        />
      </span>
    {/if}
    <span
      class="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-bold"
      data-replay-card-badge
    >
      <History size={13} strokeWidth={2.5} aria-hidden="true" />
      {m.replay_badge()}
      {#if timeLeft}
        <span class="font-medium opacity-80" data-replay-card-time-left
          >&middot; {replayTimeLeftText(timeLeft)}</span
        >
      {/if}
    </span>
    <VideoGlassGlyph kind="play" size={64} class="relative" />
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
  </Button>
</div>

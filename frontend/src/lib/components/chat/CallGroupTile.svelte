<script lang="ts">
  /**
   * ONE PARTICIPANT OF A GROUP CALL (WP-GC2): their picture when their camera sends, their photo
   * otherwise, their name, and whether their microphone is held by their system. Drawn by
   * `CallOverlay` once per leg of the call (`CallService.groupTiles`).
   *
   * The voice is NOT here: every participant's audio plays through the call's one sink
   * (`CallOverlay`, `remoteAudioMix`), so this `<video>` is muted, as every call video is.
   */
  import type { GroupCallTile } from '$lib/services/CallService';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import UserName from '$lib/components/shared/UserName.svelte';
  import { MicOff } from '@lucide/svelte';
  import { bindCallVideo } from '$lib/utils/callVideoElement';
  import { appendLog } from '$lib/utils/sessionLog';
  import { m } from '$lib/paraglide/messages';

  let {
    tile,
    scope = null,
  }: {
    tile: GroupCallTile;
    /** The call's conversation, for its nicknames ("Modifier les pseudos"). */
    scope?: string | null;
  } = $props();

  /**
   * The participant's picture: a live, unmuted video track. A muted one is their camera off, or no
   * frame yet - the photo shows, never a frozen last frame. Re-read at every publish of the tiles,
   * which the service does on each `mute` / `unmute` / `ended` of a remote track.
   */
  let videoTrack = $derived(
    tile.stream?.getVideoTracks().find((t) => t.readyState === 'live' && !t.muted) ?? null
  );
  let videoEl: HTMLVideoElement | undefined = $state();
  /** A frame was painted from the current track: until then the photo stays visible. */
  let painted = $state(false);

  $effect(() => {
    const el = videoEl;
    const track = videoTrack;
    painted = false;
    if (!el || !track) return;
    return bindCallVideo(el, track, `group tile ${tile.userId.slice(0, 8)}`, () => {
      appendLog(`[Call] group tile ${tile.userId.slice(0, 8)}: first frame painted`);
      painted = true;
    });
  });
</script>

<div
  class="relative flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden rounded-xl bg-white/10"
  data-testid="call-group-tile"
  data-user-id={tile.userId}
  data-connected={tile.connected}
>
  {#if !painted}
    <div
      class="size-20 overflow-hidden rounded-full md:size-28 {tile.connected ? '' : 'opacity-50'}"
    >
      <Avatar userId={tile.userId} fill shape="circle" />
    </div>
  {/if}
  {#if videoTrack}
    <video
      bind:this={videoEl}
      autoplay
      playsinline
      muted
      class="absolute inset-0 h-full w-full object-cover {painted ? '' : 'opacity-0'}"
    ></video>
  {/if}
  <div
    class="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 px-2 pb-2 text-sm drop-shadow-md"
  >
    {#if tile.micSuspended}
      <span class="text-accent-text inline-flex shrink-0" title={m.call_group_tile_mic_held()}>
        <MicOff size={16} aria-label={m.call_group_tile_mic_held()} />
      </span>
    {/if}
    <UserName
      userId={tile.userId}
      {scope}
      link={false}
      class="block max-w-full truncate font-semibold"
    />
  </div>
  {#if !tile.connected}
    <span class="sr-only">{m.call_group_tile_connecting()}</span>
  {/if}
</div>

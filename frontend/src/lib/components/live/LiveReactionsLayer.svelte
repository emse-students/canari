<script lang="ts">
  /**
   * THE FLOATING REACTIONS OF A LIVE (WP-L6, C7-C9): each reaction rises up the right edge and
   * fades. At most {@link LIVE_REACTION_FLOATS_MAX} are on screen at once - a burst of a hundred
   * draws the cap and drops the rest, so a crowd can never stall the video under it.
   *
   * With reduced motion nothing moves: the layer shows one static counter per kind instead (the
   * total since the viewer opened), which a screen reader does not announce on every tap.
   *
   * The caller hands reactions in through `add(kind, count)` (`bind:this`), from the chat session's
   * `onFloat`: mine at the tap, everyone else's as each poll brings them.
   */
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { LIVE_REACTION_KINDS, liveReactionEmoji, liveReactionLabel } from '$lib/live/liveChat';
  import type { LiveReactionKind } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  /** The most floats on screen at once; more are dropped, never queued. */
  const LIVE_REACTION_FLOATS_MAX = 24;

  interface Float {
    id: number;
    kind: LiveReactionKind;
    /** Horizontal place in the lane, 0..1, and a small delay so a burst does not rise as one block. */
    lane: number;
    delay: number;
  }

  let floats = $state<Float[]>([]);
  let totals = $state<Partial<Record<LiveReactionKind, number>>>({});
  let nextId = 0;

  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Floats `count` reactions of `kind` (up to the cap), or adds them to the static counter. */
  export function add(kind: LiveReactionKind, count: number): void {
    if (count <= 0) return;
    totals = { ...totals, [kind]: (totals[kind] ?? 0) + count };
    if (reducedMotion) return;
    const room = LIVE_REACTION_FLOATS_MAX - floats.length;
    const n = Math.min(count, room);
    if (n < count) {
      console.debug(`[LIVE_CHAT] ${count - n} floating ${kind} dropped at the on-screen cap`);
    }
    if (n <= 0) return;
    const fresh: Float[] = [];
    for (let i = 0; i < n; i++) {
      fresh.push({ id: nextId++, kind, lane: Math.random(), delay: i * 0.12 });
    }
    floats = [...floats, ...fresh];
  }

  function done(id: number) {
    floats = floats.filter((f) => f.id !== id);
  }
</script>

<div class="pointer-events-none absolute inset-y-0 right-0 w-24 overflow-hidden" aria-hidden="true">
  {#each floats as f (f.id)}
    <span
      class="live-float absolute bottom-24 text-2xl"
      style:left="{10 + f.lane * 55}%"
      style:animation-delay="{f.delay}s"
      onanimationend={() => done(f.id)}
      data-live-float={f.kind}
    >
      <EmojiText text={liveReactionEmoji(f.kind)} />
    </span>
  {/each}
</div>

{#if reducedMotion}
  <ul
    class="pointer-events-none absolute right-3 bottom-40 flex flex-col items-end gap-1"
    aria-label={m.live_reactions_label()}
    data-live-reaction-counters
  >
    {#each LIVE_REACTION_KINDS as kind (kind)}
      {#if totals[kind]}
        <li
          class="bg-cn-scrim/60 rounded-full px-2 py-0.5 text-sm tabular-nums"
          aria-label={m.live_reaction_count({ name: liveReactionLabel(kind), count: totals[kind] })}
          data-live-reaction-counter={kind}
        >
          <EmojiText text={liveReactionEmoji(kind)} />
          {totals[kind]}
        </li>
      {/if}
    {/each}
  </ul>
{/if}

<style>
  .live-float {
    opacity: 0;
    animation: live-float-rise 2.4s ease-out forwards;
  }

  @keyframes live-float-rise {
    0% {
      opacity: 0;
      transform: translateY(0) scale(0.6);
    }
    15% {
      opacity: 1;
      transform: translateY(-2rem) scale(1);
    }
    100% {
      opacity: 0;
      transform: translateY(-16rem) scale(1.1);
    }
  }
</style>

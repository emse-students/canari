<script lang="ts">
  /**
   * THE HEADER OF A PROFILE, ONE LAYOUT FOR SOMEONE ELSE'S AND FOR YOUR OWN (owner, 2026-11-09,
   * on a ~1100 px desktop: *"Wow, ca c'est moche"* - the name wrapped to two lines and the action
   * row was drawn ON TOP of the second one, hiding it).
   *
   * THE RULE: NOTHING IS POSITIONED OVER ANYTHING. The identity (avatar, name, chips) and the action
   * row are two siblings of a wrapping flex container. The identity asks for a basis of 26rem
   * and may shrink below it (`min-w-0`); the action row keeps its own width. When both do not fit on
   * one line the action row drops BELOW the identity, at every width - a phone, a tablet, a desktop
   * - and the name takes whatever width its own column has and wraps there. No `absolute`, no
   * margin that reserves a corner, so there is no width at which two things share a pixel.
   *
   * Below `sm` the identity is the centred column of the 2026-09-14 directive (avatar, name,
   * formation, one axis); from `sm` it is a row, avatar left, as Instagram draws it.
   *
   * The caller supplies what differs: the details under the name, the actions, and an optional
   * badge pinned to the avatar (the own profile's camera).
   */
  import type { Snippet } from 'svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';

  interface Props {
    userId: string;
    /** The display name, drawn as the page's `h1`. */
    name: string;
    /** Under the name: the badge, the chips, the birthday line. */
    details?: Snippet;
    /** The action row: it wraps below the identity when there is no room beside it. */
    actions?: Snippet;
    /** Drawn over the avatar's corner (it is the avatar's own, never the name's). */
    avatarBadge?: Snippet;
  }

  let { userId, name, details, actions, avatarBadge }: Props = $props();
</script>

<div
  data-profile-header
  class="animate-in fade-in slide-in-from-bottom-4 flex flex-col items-center gap-5 duration-500 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-5"
>
  <div
    data-profile-identity
    class="flex min-w-0 flex-col items-center gap-5 sm:flex-1 sm:basis-[26rem] sm:flex-row sm:gap-6"
  >
    <!-- `isolate`: the avatar's own layers (the gradient story ring) stack inside this box, and the badge (`z-10`) always sits above them. -->
    <div class="relative isolate h-24 w-24 shrink-0 sm:h-28 sm:w-28">
      <div
        class="h-full w-full overflow-hidden rounded-full shadow-lg ring-4 ring-white/50 dark:ring-black/20"
      >
        <Avatar {userId} fill shape="circle" />
      </div>
      {@render avatarBadge?.()}
    </div>
    <div class="min-w-0 text-center sm:flex-1 sm:text-left">
      <h1
        data-profile-name
        class="text-text-main mb-1 text-2xl font-bold text-balance wrap-break-word sm:text-3xl"
      >
        {name}
      </h1>
      {@render details?.()}
    </div>
  </div>

  {#if actions}
    <div
      data-profile-actions
      class="flex w-full items-center justify-center gap-2 sm:w-auto sm:shrink-0 sm:justify-start"
    >
      {@render actions()}
    </div>
  {/if}
</div>

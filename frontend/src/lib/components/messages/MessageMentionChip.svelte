<script lang="ts">
  import { goto } from '$app/navigation';
  import { peekUserDisplayName, resolveUserDisplayName } from '$lib/utils/users/displayName';

  interface Props {
    userId: string;
  }

  let { userId }: Props = $props();

  /**
   * `null` while the name is genuinely not known YET, which is not the same as knowing there is
   * none - only the second may be rendered as a word.
   *
   * The chip resolves for itself rather than taking a label from the parser, because the parser
   * runs once per message body and cannot re-render when a name arrives: whatever it guessed on a
   * cold cache was frozen into the message. It used to guess the raw user id, so a mention read
   * `@3f9a1c2b...` until something unrelated happened to warm the cache; seeding a placeholder
   * label instead would only have changed which wrong thing was frozen.
   */
  let resolved = $state<string | null>(null);

  $effect(() => {
    // The synchronous half is a cache READ, so a warm cache paints the name on the first frame and
    // there is no flash at all. Only a real miss reaches the await.
    resolved = peekUserDisplayName(userId);
    void resolveUserDisplayName(userId).then((name) => {
      if (name) resolved = name;
    });
  });

  function openProfile(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    void goto(`/profile/${userId}`);
  }
</script>

<button
  type="button"
  onclick={openProfile}
  class="inline cursor-pointer rounded-full bg-amber-500/10 px-1 align-baseline text-[0.9em] font-semibold text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
>
  @{resolved ?? ''}
</button>

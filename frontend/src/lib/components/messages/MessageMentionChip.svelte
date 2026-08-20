<script lang="ts">
  import { goto } from '$app/navigation';

  interface Props {
    userId: string;
    name: string;
  }

  let { userId, name }: Props = $props();

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
  @{name}
</button>

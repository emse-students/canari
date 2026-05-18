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
  class="font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-full px-1 text-[0.9em] hover:bg-amber-500/20 transition-colors cursor-pointer inline align-baseline"
>
  @{name}
</button>

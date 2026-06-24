<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';
</script>

<main class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
  <p class="text-2xl font-bold text-text-main">{page.status}</p>
  <p class="text-text-muted">{page.error?.message ?? m.error_unexpected_message()}</p>
  <button
    class="mt-2 px-4 py-2 rounded-xl bg-cn-yellow text-cn-ink font-semibold text-sm"
    onclick={() => goto('/login', { replaceState: true })}
  >
    {m.error_back_home()}
  </button>
</main>

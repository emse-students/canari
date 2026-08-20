<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
  <p class="text-text-main text-2xl font-bold">{page.status}</p>
  <p class="text-text-muted">{page.error?.message ?? m.error_unexpected_message()}</p>
  <button
    class="bg-cn-yellow text-cn-ink mt-2 rounded-xl px-4 py-2 text-sm font-semibold"
    onclick={() => goto('/login', { replaceState: true })}
  >
    {m.error_back_home()}
  </button>
</main>

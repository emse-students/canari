<script lang="ts">
  /**
   * WHAT A FAILED PAGE SHOWS - a load that failed, an address with no route, AND (since SvelteKit 3)
   * a page that threw while it rendered: Kit wraps every route node in its own boundary armed with
   * this file, closer to the page than the root layout, so this is the only crash screen there is.
   * The report itself is `handleClientError`'s (`hooks.client.ts`), which Kit calls before this draws.
   *
   * A 5xx offers the RETRY the layout's boundary used to: navigating to the same address again is
   * what makes Kit reset a failed boundary (`navigate` drains its resetters), and `refreshAll`
   * re-runs the loads, so it retries a failed load and a crashed render alike. The way out is the
   * home page, never `/login`: the reader is usually signed in, and the root layout's guard is what
   * sends a signed-out one to sign in.
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { appPathFromPathname, internalPath } from '$lib/utils/internalPath';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  const failed = $derived(page.status >= 500);

  function retry() {
    const here = appPathFromPathname(page.url.pathname) + page.url.search + page.url.hash;
    Log.d('error-page', `retry on ${page.route.id ?? '?'}`);
    void goto(resolve(internalPath(here)), { replace: true, refreshAll: true });
  }

  function home() {
    Log.d('error-page', `home from ${page.route.id ?? '?'} (status ${page.status})`);
    void goto(resolve('/posts'), { replace: true });
  }
</script>

<main class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
  <p class="text-text-main text-2xl font-bold">{page.status}</p>
  <p class="text-text-muted">
    {failed
      ? m.layout_error_boundary_message()
      : (page.error?.message ?? m.error_unexpected_message())}
  </p>
  <div class="mt-2 flex gap-3">
    {#if failed}
      <button
        type="button"
        onclick={retry}
        class="bg-cn-yellow text-cn-ink rounded-xl px-4 py-2 text-sm font-semibold"
      >
        {m.common_retry_button()}
      </button>
    {/if}
    <button
      type="button"
      onclick={home}
      class="{failed
        ? 'border-cn-border text-text-main border'
        : 'bg-cn-yellow text-cn-ink'} rounded-xl px-4 py-2 text-sm font-semibold"
    >
      {m.error_back_home()}
    </button>
  </div>
</main>

<script lang="ts">
  import { UserRound } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHO IS FILLING THE FORM, AND THE PRICE CATEGORY THE SERVER PUT THEM IN - read-only (WP-G2).
   *
   * "Camille Martin - Tarif applique : Cotisant BDE" for a member; "Tarif applique : Tous les autres"
   * and a sign-in link for a guest, whose category is always "everyone else" until they sign in. The
   * category is the server's (`productGridPrices`): the page never decides it.
   */
  interface Props {
    /** The member's display name; null for a guest. */
    name: string | null;
    /** The categories applied, each once (`appliedTierLabels`). */
    tierLabels: string[];
    /** A guest's way to their own price: the sign-in page, back to this form. Null for a member. */
    loginHref?: string | null;
  }

  let { name, tierLabels, loginHref = null }: Props = $props();
</script>

<div
  class="bg-cn-bg text-text-main flex flex-col gap-1 rounded-lg px-3 py-2.5 text-xs sm:text-sm"
  data-viewer-tier
>
  <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
    <UserRound size={16} class="shrink-0" aria-hidden="true" />
    {#if name}
      <span>{name}</span>
      <span aria-hidden="true" class="text-text-muted">&middot;</span>
    {/if}
    <span>{m.form_viewer_tier_prefix()} <b>{tierLabels.join(', ')}</b></span>
  </span>
  {#if loginHref}
    <span>
      {m.form_guest_login_prompt()}
      <a href={loginHref} class="font-bold underline">{m.form_guest_login_link()}</a>
    </span>
  {/if}
</div>

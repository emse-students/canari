<script lang="ts">
  import { Grip } from '@lucide/svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { ECOSYSTEM_SITES } from '$lib/navigation/ecosystemSites';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { fade } from 'svelte/transition';

  /**
   * THE APP LAUNCHER: one grid button in the app header, opening the other student sites -
   * MiGallery, Le Cercle, Sky, Portail-etu - each by its logo (user, 2026-09-27: *"un bouton facile d'acces vers
   * la galerie, le site du cercle, sky depuis Canari"*, then *"Tu pourrais aussi ajouter
   * portail-etu"*). Google's nine-dot launcher is the shape:
   * it costs the header one control however many sites the list grows to, and it sits in the same
   * place on a phone and on a desktop.
   *
   * EVERY LINK OPENS A NEW TAB. Leaving Canari in the same tab would drop its socket and its MLS
   * state, and coming back would pay for both again. On the native shells the global link handler
   * sends the same anchor to the system browser, so no branch here knows which runtime it is in.
   *
   * Positioned like `PostActionsMenu`: portalled, placed against its button by `bindFixedPopover`,
   * dismissed by a `clickOutside` that sees through the portal.
   */
  let open = $state(false);
  let buttonEl: HTMLButtonElement | null = $state(null);
  let panelEl: HTMLDivElement | null = $state(null);

  $effect(() => {
    if (!open || !panelEl || !buttonEl) return;
    return bindFixedPopover(panelEl, { anchor: () => buttonEl, alignEnd: true, offset: 6 });
  });

  function toggle() {
    open = !open;
    Log.d('ecosystemLauncher.toggle', { open });
  }

  function close(reason: string) {
    if (!open) return;
    Log.d('ecosystemLauncher.close', { reason });
    open = false;
  }
</script>

<div class="flex shrink-0 items-center" use:clickOutside={() => close('outside')}>
  <button
    bind:this={buttonEl}
    type="button"
    onclick={toggle}
    aria-expanded={open}
    aria-haspopup="menu"
    aria-label={m.ecosystem_launcher_label()}
    title={m.ecosystem_launcher_label()}
    class="ui-icon-button text-text-muted hover:text-text hover:bg-cn-surface rounded-full {open
      ? 'bg-cn-surface text-text'
      : ''}"
  >
    <Grip size={22} strokeWidth={2.5} />
  </button>

  {#if open}
    <div
      bind:this={panelEl}
      use:portal
      role="menu"
      tabindex="-1"
      aria-label={m.ecosystem_launcher_label()}
      class="bg-surface-elevated border-cn-border fixed z-(--z-popover) grid w-64 grid-cols-2 gap-1 rounded-xl border p-2 shadow-lg"
      transition:fade={{ duration: 120 }}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          close('escape');
          buttonEl?.focus();
        }
      }}
    >
      {#each ECOSYSTEM_SITES as site (site.id)}
        <a
          href={site.href}
          target="_blank"
          rel="noopener"
          role="menuitem"
          onclick={() => {
            Log.d('ecosystemLauncher.open', { site: site.id });
            close('picked');
          }}
          class="text-text-main flex flex-col items-center gap-2 rounded-lg px-1 py-3 text-sm font-medium transition-colors hover:bg-amber-500/10"
        >
          <img src={site.logo} alt="" width="48" height="48" class="size-12" />
          <span class="max-w-full truncate">{site.label()}</span>
        </a>
      {/each}
    </div>
  {/if}
</div>

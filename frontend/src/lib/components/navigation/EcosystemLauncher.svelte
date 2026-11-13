<script lang="ts">
  import { Grip } from '@lucide/svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { portal } from '$lib/actions/portal';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { ECOSYSTEM_SITES } from '$lib/navigation/ecosystemSites';
  import { openEcosystemSite } from '$lib/navigation/openEcosystemSite';
  import { ECOSYSTEM_SITE_ATTRIBUTE } from '$lib/utils/openExternal';
  import { isTauriRuntime } from '$lib/utils/tauriRuntime';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { slide } from 'svelte/transition';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { useOverlayLayer } from '$lib/utils/overlayLayer.svelte';
  import { isMobileOverlayLayout } from '$lib/utils/historyOverlayStack';

  /**
   * THE APP LAUNCHER: one grid button in the app header, opening the other student sites -
   * MiGallery, Le Cercle, Sky, Portail-etu - each by its logo (user, 2026-09-27: *"un bouton facile d'acces vers
   * la galerie, le site du cercle, sky depuis Canari"*, then *"Tu pourrais aussi ajouter
   * portail-etu"*). Google's nine-dot launcher is the shape:
   * it costs the header one control however many sites the list grows to, and it sits in the same
   * place on a phone and on a desktop.
   *
   * EVERY LINK OPENS A NEW TAB. Leaving Canari in the same tab would drop its socket and its MLS
   * state, and coming back would pay for both again. A plain click goes through `openEcosystemSite`,
   * the one opener, which opens a site whose sign-in handoff is on SIGNED IN (the system browser on
   * the native shells, a new tab on the web) and every other site plainly. The anchor keeps its
   * address for a modified or middle click on the web, which opens it plainly as before (on the
   * native shells every click goes through the opener: their webview has no tab to open); the global link
   * handler leaves it alone (`ECOSYSTEM_SITE_ATTRIBUTE`).
   *
   * Positioned like `PostActionsMenu`: portalled, placed against its button by `bindFixedPopover`,
   * dismissed by a `clickOutside` that sees through the portal.
   */
  let open = $state(false);

  /** Registered while open: z-index by open order, the last opened on top (`utils/overlayStack.ts`). */
  const layer = useOverlayLayer(() => open, 'EcosystemLauncher');
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

  // On a phone the open menu holds a history entry: the system Back closes the menu, not the page
  // under it (audit of 2026-10-13). A wide window's popover is closed by a click beside it.
  bindHistoryOverlay(
    () => open && isMobileOverlayLayout(),
    () => close('back')
  );
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
    class="ui-icon-button hover:bg-text-main/10 hover:text-text-main rounded-lg transition-colors {open
      ? 'bg-text-main/10 text-text-main'
      : 'text-text-muted'}"
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
      style:z-index={layer.z}
      class="glass-chrome border-cn-border fixed grid w-64 grid-cols-2 gap-1 rounded-xl p-2"
      transition:slide={{ duration: 150 }}
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
          {...{ [ECOSYSTEM_SITE_ATTRIBUTE]: site.id }}
          onclick={(e) => {
            Log.d('ecosystemLauncher.open', { site: site.id });
            close('picked');
            // A modified click keeps the browser's own handling on the web (a plain new tab). The native
            // shells have no such handling - their webview opens nothing - so there every click goes
            // through the opener.
            if (
              !isTauriRuntime() &&
              (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
            )
              return;
            e.preventDefault();
            openEcosystemSite(site.id);
          }}
          class="text-text-main hover:bg-accent/10 flex flex-col items-center gap-2 rounded-lg px-1 py-3 text-sm font-medium transition-colors"
        >
          <img src={site.logo} alt="" width="48" height="48" class="size-12" />
          <span class="max-w-full truncate">{site.label()}</span>
        </a>
      {/each}
    </div>
  {/if}
</div>

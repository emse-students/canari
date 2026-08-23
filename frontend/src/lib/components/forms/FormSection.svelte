<script lang="ts">
  import { ChevronDown, type Icon as IconType } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  /**
   * One card of the form editor: icon, title, an optional counter on the right, and the fields.
   *
   * The three sections of the create page each carried their own copy of this markup, which is why
   * one of them had `p-3 sm:p-6` where the others had `p-4 sm:p-6` and only one bothered with the
   * horizontal padding on its header. Adding a fourth section by copying a third time is what this
   * replaces.
   *
   * `collapsible` turns the header into a button. A collapsed section is how a rarely-used setting
   * stays reachable without occupying the screen of everyone who does not need it.
   */
  interface Props {
    /** Section heading. */
    title: string;
    /** Lucide icon shown in the yellow tile. */
    icon: typeof IconType;
    /** Small pill on the right of the header, e.g. a question count. */
    badge?: string;
    /** When true, the header toggles the body open and shut. */
    collapsible?: boolean;
    /** Initial state of a collapsible section; ignored otherwise. */
    startOpen?: boolean;
    /** Tighter padding, for a body that already carries its own cards. */
    dense?: boolean;
    /** The section's fields. */
    children: Snippet;
  }

  let {
    title,
    icon: SectionIcon,
    badge,
    collapsible = false,
    startOpen = true,
    dense = false,
    children,
  }: Props = $props();

  /**
   * Null until the header is pressed, so the section follows `startOpen` until someone decides
   * otherwise. Seeding `$state` from the prop instead would capture only its initial value - the
   * mistake Svelte warns about - and would ignore a `startOpen` that arrives with the data.
   */
  let userToggled = $state<boolean | null>(null);
  const open = $derived(userToggled ?? startOpen);
  const bodyIsVisible = $derived(!collapsible || open);
</script>

<section
  class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) sm:mb-5 sm:p-6 {dense
    ? 'p-3'
    : 'p-4'}"
>
  {#snippet header()}
    <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2">
      <SectionIcon size={20} />
    </div>
    <h2 class="text-text-main text-lg font-bold">{title}</h2>
    {#if badge}
      <span
        class="text-text-muted bg-cn-border/40 ml-auto rounded-full px-2.5 py-1 text-xs font-semibold"
      >
        {badge}
      </span>
    {/if}
  {/snippet}

  {#if collapsible}
    <button
      type="button"
      onclick={() => (userToggled = !open)}
      aria-expanded={open}
      class="flex w-full items-center gap-2.5 text-left"
    >
      {@render header()}
      <ChevronDown
        size={18}
        class="text-text-muted transition-transform {badge ? '' : 'ml-auto'} {open
          ? 'rotate-180'
          : ''}"
      />
    </button>
  {:else}
    <div class="mb-4 flex items-center gap-2.5 sm:mb-5">
      {@render header()}
    </div>
  {/if}

  {#if bodyIsVisible}
    <div class={collapsible ? 'border-cn-border mt-5 space-y-4 border-t-2 pt-5' : 'space-y-4'}>
      {@render children()}
    </div>
  {/if}
</section>

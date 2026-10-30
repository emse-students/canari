<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import type { Component, Snippet } from 'svelte';

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
    icon?: Component;
    /**
     * The section's place in a numbered list (the bookings editor's five questions): a numbered disc
     * replaces the icon tile, and the summary lines up under the title. Omit for an icon section.
     */
    step?: number;
    /** Small pill on the right of the header, e.g. a question count. */
    badge?: string;
    /**
     * One line under the title: the section's current answer, so a closed section still reads. It is
     * OUTSIDE the header button (a button holds phrasing content only) and describes it.
     */
    summary?: string;
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
    step,
    badge,
    summary,
    collapsible = false,
    startOpen = true,
    dense = false,
    children,
  }: Props = $props();
  const uid = $props.id();

  /**
   * Null until the header is pressed, so the section follows `startOpen` until someone decides
   * otherwise. Seeding `$state` from the prop instead would capture only its initial value - the
   * mistake Svelte warns about - and would ignore a `startOpen` that arrives with the data.
   */
  let userToggled = $state<boolean | null>(null);
  const open = $derived(userToggled ?? startOpen);
  const bodyIsVisible = $derived(!collapsible || open);
  /** Names the summary line, so a collapsible header's button is DESCRIBED by it (it cannot hold it). */
  const summaryId = `${uid}-summary`;
</script>

<section
  class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) sm:mb-5 sm:p-6 {dense
    ? 'p-3'
    : 'p-4'}"
>
  {#snippet header()}
    {#if step !== undefined}
      <span
        class="bg-control-fill text-text-main grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold tabular-nums before:content-[attr(data-step)]"
        data-step={step}
        aria-hidden="true"
      ></span>
    {:else if SectionIcon}
      <span class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2">
        <SectionIcon size={20} />
      </span>
    {/if}
    <span class="text-text-main min-w-0 flex-1 basis-0 text-lg font-bold break-words">{title}</span>
    {#if badge}
      <span
        class="text-text-muted bg-cn-border/40 ml-auto rounded-full px-2.5 py-1 text-xs font-semibold"
      >
        {badge}
      </span>
    {/if}
  {/snippet}

  <!-- The heading wraps the button, never the reverse: a button holds phrasing content only. -->
  {#if collapsible}
    <h2>
      <button
        type="button"
        onclick={() => (userToggled = !open)}
        aria-expanded={open}
        aria-describedby={summary ? summaryId : undefined}
        class="flex w-full flex-wrap items-center gap-2.5 text-left"
      >
        {@render header()}
        <ChevronDown
          size={18}
          class="text-text-muted transition-transform {badge ? '' : 'ml-auto'} {open
            ? 'rotate-180'
            : ''}"
        />
      </button>
    </h2>
    {#if summary}
      <p
        id={summaryId}
        class="text-text-muted text-xs break-words {step !== undefined
          ? 'ms-[2.375rem] mt-1'
          : 'mt-2'}"
      >
        {summary}
      </p>
    {/if}
  {:else}
    <div class="mb-4 sm:mb-5">
      <h2 class="flex flex-wrap items-center gap-2.5">
        {@render header()}
      </h2>
      {#if summary}
        <p
          id={summaryId}
          class="text-text-muted text-xs break-words {step !== undefined
            ? 'ms-[2.375rem] mt-1'
            : 'mt-2'}"
        >
          {summary}
        </p>
      {/if}
    </div>
  {/if}

  {#if bodyIsVisible}
    <div class={collapsible ? 'border-cn-border mt-5 space-y-4 border-t-2 pt-5' : 'space-y-4'}>
      {@render children()}
    </div>
  {/if}
</section>

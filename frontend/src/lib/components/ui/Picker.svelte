<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { Check, ChevronDown } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { bindFixedPopover } from '$lib/actions/fixedPopover';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { groupPickerOptions, pickerKeyTarget, type PickerOption } from './picker';
  import { controlClass, type ControlDensity } from './controlClasses';

  /**
   * A choice among a few options, drawn BY THE APP - a sheet rising from the bottom on a phone, a
   * popover under its trigger on a wider window.
   *
   * WHY NOT A `<select>` (user, 2026-09-29, on the Mi 9T): *"c'est un truc natif, pas in app. A cet
   * endroit comme a d'autres, il ne vaut mieux pas sortir de l'experience de l'application"*. A native
   * select on Android opens the SYSTEM's dialog - its font, its radio buttons, its colours, none of
   * the app's - and it cannot draw what the choice is about: choosing who publishes a post showed a
   * list of bare names where the composer itself shows avatars.
   *
   * The two shapes are decided when it OPENS, by the same `40rem` the full-screen composer uses, so
   * a picker inside a phone-sized window is always a sheet under the thumb and never a popover
   * hanging off a control near the bottom of the glass. Both are portalled to the body and stack at
   * `--z-modal-popover`, because the pickers that matter most open from inside a modal.
   *
   * It is a listbox for assistive technology: the options are `role="option"` with `aria-selected`,
   * arrows move between them and wrap, Home/End jump, Escape closes and returns focus to the trigger.
   * Escape is stopped at the panel, so a picker inside a modal closes itself and not the modal.
   */
  interface Props {
    /** The selected option's value. */
    value: string;
    options: PickerOption[];
    /** Called with the new value when a DIFFERENT option is picked. */
    onValueChange: (value: string) => void;
    /** Names the choice: the trigger's accessible name and the sheet's title. */
    label: string;
    disabled?: boolean;
    /** HTML id of the trigger, so a `<label for>` can point at it. */
    id?: string;
    /** Classes of the trigger button. Defaults to a plain text-and-chevron line. */
    triggerClass?: string;
    /** Custom trigger content; receives the selected option (undefined when none matches). */
    trigger?: Snippet<[PickerOption | undefined]>;
    /** Drawn before each option's label - an avatar, an icon. */
    leading?: Snippet<[PickerOption]>;
    /** Shown on the trigger when no option matches `value`. */
    placeholder?: string;
    /**
     * `inline`: text and a chevron, for a choice drawn as part of a sentence or a header.
     * `field`: the full-width box every form control wears (`controlClass`), for a settings form.
     * Ignored when `triggerClass` is given.
     */
    variant?: 'inline' | 'field';
    /** Density of the `field` variant, as `controlClass` names it. */
    density?: ControlDensity;
    /** Marks the `field` variant invalid. */
    invalid?: boolean;
  }

  let {
    value,
    options,
    onValueChange,
    label,
    disabled = false,
    id,
    triggerClass = '',
    trigger,
    leading,
    placeholder = '',
    variant = 'inline',
    density = 'compact',
    invalid = false,
  }: Props = $props();

  const INLINE_TRIGGER =
    'text-text-main flex max-w-full items-center gap-1 truncate rounded-lg px-1 py-1 text-sm font-semibold outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:opacity-60 dark:hover:bg-white/10';

  const resolvedTriggerClass = $derived(
    triggerClass ||
      (variant === 'field'
        ? `${controlClass(invalid, density)} flex items-center justify-between gap-2 text-left cursor-pointer disabled:cursor-default`
        : INLINE_TRIGGER)
  );

  /** The width under which the picker is a bottom sheet - `phoneFullScreen`'s breakpoint. */
  const SHEET_QUERY = '(width < 40rem)';

  let open = $state(false);
  let asSheet = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let panelEl: HTMLDivElement | null = $state(null);

  const selected = $derived(options.find((o) => o.value === value));
  const groups = $derived(groupPickerOptions(options));

  function optionButtons(): HTMLButtonElement[] {
    return Array.from(panelEl?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
  }

  async function openPicker() {
    if (disabled) return;
    asSheet = window.matchMedia(SHEET_QUERY).matches;
    open = true;
    Log.d(
      'PICKER',
      `open "${label}" as ${asSheet ? 'sheet' : 'popover'}, ${options.length} options`
    );
    await tick();
    const buttons = optionButtons();
    const current = buttons.find((b) => b.getAttribute('aria-selected') === 'true') ?? buttons[0];
    current?.focus({ preventScroll: true });
    current?.scrollIntoView({ block: 'nearest' });
  }

  function closePicker(refocus: boolean) {
    if (!open) return;
    open = false;
    if (refocus) triggerEl?.focus({ preventScroll: true });
  }

  function pick(option: PickerOption) {
    Log.d('PICKER', `"${label}" -> ${option.value === value ? 'unchanged' : 'changed'}`);
    if (option.value !== value) onValueChange(option.value);
    closePicker(true);
  }

  function handlePanelKeydown(e: KeyboardEvent) {
    // Stopped here so a modal's own window-level Escape never sees it: this closes the picker only.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker(true);
      return;
    }
    if (e.key === 'Tab') {
      closePicker(false);
      return;
    }
    const buttons = optionButtons();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = pickerKeyTarget(e.key, current, buttons.length);
    if (next === null) return;
    e.preventDefault();
    buttons[next].focus();
  }

  $effect(() => {
    if (!open || asSheet || !panelEl || !triggerEl) return;
    panelEl.style.minWidth = `${triggerEl.offsetWidth}px`;
    return bindFixedPopover(panelEl, { anchor: () => triggerEl, offset: 4, estimatedHeight: 360 });
  });
</script>

<button
  bind:this={triggerEl}
  {id}
  type="button"
  {disabled}
  aria-haspopup="listbox"
  aria-expanded={open}
  aria-label={label ? `${label} - ${selected?.label ?? placeholder}` : undefined}
  class={resolvedTriggerClass}
  onclick={() => (open ? closePicker(false) : openPicker())}
>
  {#if trigger}
    {@render trigger(selected)}
  {:else}
    <span class="min-w-0 truncate">{selected?.label ?? placeholder}</span>
    <ChevronDown size={16} strokeWidth={2.5} class="text-text-muted shrink-0" />
  {/if}
</button>

{#snippet list()}
  <div
    role="listbox"
    aria-label={label}
    tabindex="-1"
    class="flex flex-col gap-0.5 outline-none"
    onkeydown={handlePanelKeydown}
  >
    {#each groups as group, gi (gi)}
      {#if group.heading}
        <div
          role="presentation"
          class="text-text-muted text-2xs px-3 pt-2.5 pb-1 font-bold tracking-wider uppercase"
        >
          {group.heading}
        </div>
      {/if}
      {#each group.options as option (option.value)}
        {@const isSelected = option.value === value}
        <button
          type="button"
          role="option"
          aria-selected={isSelected}
          class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors outline-none hover:bg-black/5 focus-visible:bg-black/5 dark:hover:bg-white/10 dark:focus-visible:bg-white/10 {isSelected
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-text-main'}"
          onclick={() => pick(option)}
        >
          {#if leading}
            <span class="shrink-0">{@render leading(option)}</span>
          {/if}
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-semibold">{option.label}</span>
            {#if option.description}
              <span class="text-text-muted block truncate text-xs">{option.description}</span>
            {/if}
          </span>
          {#if isSelected}
            <Check size={18} strokeWidth={2.5} class="shrink-0" />
          {/if}
        </button>
      {/each}
    {/each}
  </div>
{/snippet}

{#if open && asSheet}
  <div use:portal class="fixed inset-0 z-(--z-modal-popover)">
    <button
      type="button"
      class="absolute inset-0 cursor-default bg-black/45 outline-none"
      aria-label={m.common_close_label()}
      tabindex="-1"
      onclick={() => closePicker(true)}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabindex="-1"
      class="bg-surface-elevated absolute inset-x-0 bottom-0 flex max-h-[70dvh] flex-col rounded-t-2xl pb-[max(0.5rem,var(--safe-area-inset-bottom,0px))] shadow-2xl"
      transition:fly={{ y: 32, duration: 200 }}
    >
      <div class="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-black/15 dark:bg-white/20"></div>
      <p class="text-text-main shrink-0 px-5 pt-3 pb-2 text-base font-bold">{label}</p>
      <div class="min-h-0 overflow-y-auto overscroll-contain px-2">
        {@render list()}
      </div>
    </div>
  </div>
{:else if open}
  <div
    bind:this={panelEl}
    use:portal
    use:clickOutside={{
      enabled: open,
      callback: () => closePicker(false),
      ignore: () => triggerEl,
    }}
    role="group"
    aria-label={label}
    tabindex="-1"
    class="bg-surface-elevated border-cn-border fixed z-(--z-modal-popover) w-max max-w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-xl border p-1.5 shadow-lg"
    transition:fade={{ duration: 120 }}
  >
    {@render list()}
  </div>
{/if}

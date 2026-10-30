<script lang="ts">
  import { templatePreview, type TemplateKey } from '$lib/bookings/availabilityPaint';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE FOUR WEEK TEMPLATES AS CARDS (D49, D52), each with a miniature week drawn from what it
   * opens (`templatePreview`), so a card shows its result before it is pressed. One component for
   * the availability editor and the creation wizard: the two used to carry the same four buttons.
   * `selected` is passed by the wizard, which keeps the chosen card lit; the editor leaves it out,
   * a template there being an action rather than a state.
   */
  interface Props {
    /** The card to light, or undefined where a template is an action and nothing stays chosen. */
    selected?: TemplateKey | null;
    onPick: (key: TemplateKey) => void;
  }

  let { selected, onPick }: Props = $props();

  const TEMPLATES: { key: TemplateKey; name: () => string; sub: () => string }[] = [
    {
      key: 'always',
      name: () => m.bookings_avail_tpl_always(),
      sub: () => m.bookings_avail_tpl_always_sub(),
    },
    {
      key: 'weekdays',
      name: () => m.bookings_avail_tpl_weekdays(),
      sub: () => m.bookings_avail_tpl_weekdays_sub(),
    },
    {
      key: 'event',
      name: () => m.bookings_avail_tpl_event(),
      sub: () => m.bookings_avail_tpl_event_sub(),
    },
    {
      key: 'empty',
      name: () => m.bookings_avail_tpl_empty(),
      sub: () => m.bookings_avail_tpl_empty_sub(),
    },
  ];
</script>

<div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
  {#each TEMPLATES as tpl (tpl.key)}
    {@const lit = selected === tpl.key}
    <button
      type="button"
      data-template={tpl.key}
      aria-pressed={selected === undefined ? undefined : lit}
      onclick={() => onPick(tpl.key)}
      class="hover:border-cn-yellow/60 flex min-h-11 flex-col items-stretch gap-2 rounded-xl border p-3 text-left transition-colors {lit
        ? 'border-cn-yellow bg-cn-yellow/10'
        : 'border-cn-border bg-cn-surface'}"
    >
      <span class="grid h-9 grid-cols-7 gap-0.5" aria-hidden="true">
        {#each Array.from({ length: 7 }, (_, day) => day) as day (day)}
          <span class="bg-control-fill relative overflow-hidden rounded-xs">
            {#each templatePreview(tpl.key).filter((b) => b.day === day) as bar (bar.from)}
              <span
                class="bg-cn-yellow absolute inset-x-0"
                style:top="{bar.from * 100}%"
                style:height="{(bar.to - bar.from) * 100}%"
              ></span>
            {/each}
          </span>
        {/each}
      </span>
      <span class="min-w-0">
        <span class="text-text-main block text-sm font-bold">{tpl.name()}</span>
        <span class="text-text-muted block text-xs">{tpl.sub()}</span>
      </span>
    </button>
  {/each}
</div>

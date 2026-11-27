<script lang="ts">
  import { Flag, Pickaxe } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE FIRST CHOICE OF GESTURES (owner, 2026-11-27): before the first lesson, the player says which action a
   * short press (a left click) does - dig or flag -, the long press (the right click) doing the other. The
   * choice is stored where the game reads it (`controls.ts`), and can be changed later under any grid.
   */
  interface Props {
    /** Names the gestures for a finger (short / long press) or for a mouse (left / right click). */
    touch: boolean;
    onChoose: (flagPrimary: boolean) => void;
  }

  let { touch, onChoose }: Props = $props();

  const dig = m.minesweeper_controls_action_dig();
  const flag = m.minesweeper_controls_action_flag();
  const line = (short: string, long: string) =>
    touch
      ? m.minesweeper_controls_touch({ short, long })
      : m.minesweeper_controls_mouse({ short, long });
</script>

<section
  class="border-accent bg-accent/10 mb-4 space-y-3 rounded-2xl border p-4"
  data-testid="controls-choice"
  aria-labelledby="controls-choice-title"
>
  <h2 id="controls-choice-title" class="text-text-main text-base font-bold">
    {m.minesweeper_controls_choice_title()}
  </h2>
  <p class="text-text-main text-sm">{m.minesweeper_controls_choice_body()}</p>
  <div class="grid gap-2 sm:grid-cols-2">
    <Button
      variant="secondary"
      data-choice="dig"
      onclick={() => onChoose(false)}
      class="h-auto flex-col items-start gap-1 py-3 text-left"
    >
      <span class="flex items-center gap-2 font-bold">
        <Pickaxe size={16} strokeWidth={2.25} />
        {m.minesweeper_controls_dig_first()}
      </span>
      <span class="text-text-muted text-xs font-normal">{line(dig, flag)}</span>
    </Button>
    <Button
      variant="secondary"
      data-choice="flag"
      onclick={() => onChoose(true)}
      class="h-auto flex-col items-start gap-1 py-3 text-left"
    >
      <span class="flex items-center gap-2 font-bold">
        <Flag size={16} strokeWidth={2.25} />
        {m.minesweeper_controls_flag_first()}
      </span>
      <span class="text-text-muted text-xs font-normal">{line(flag, dig)}</span>
    </Button>
  </div>
</section>

<script lang="ts">
  /**
   * The grip of a zone row in the carte editor's panel: dragged to reorder, or moved one step with
   * the Up and Down arrow keys.
   *
   * THE DRAG LIVES ON A WRAPPER, NOT ON THE BUTTON: Firefox does not start a drag from a
   * `<button draggable>` (the element swallows the mousedown), so the button stays a plain button
   * and the `<span>` around it carries `draggable`.
   *
   * THE KEYBOARD PATH NEVER DISABLES THE GRIP. A disabled button drops focus, so the second arrow
   * press went nowhere - one step per focus. The guard is `moving`: a press while a move is still
   * being written is ignored (the next one would be computed from the order the first is about to
   * replace), and focus is handed back once the move has settled, because a keyed list that
   * re-orders moves the node and some browsers blur it on the way.
   */
  import { tick } from 'svelte';
  import { GripVertical } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The zone this grip belongs to; marks the wrapper (`data-zone-grip`). */
    zoneId: string;
    /** The accessible name, already localised. */
    label: string;
    /** Moves the zone one step; resolves once the new order is written. */
    onMove: (delta: -1 | 1) => Promise<void> | void;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
  }

  let { zoneId, label, onMove, onDragStart, onDragEnd }: Props = $props();

  let wrapper = $state<HTMLElement>();
  let moving = false;

  async function onKeydown(e: KeyboardEvent): Promise<void> {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    if (moving) {
      Log.d('ZoneGrip.onKeydown ignored: a move is still being written', { zoneId });
      return;
    }
    moving = true;
    try {
      await onMove(delta);
    } finally {
      moving = false;
      await tick();
      wrapper?.querySelector('button')?.focus();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  bind:this={wrapper}
  data-zone-grip={zoneId}
  draggable="true"
  class="inline-flex shrink-0 cursor-grab"
  ondragstart={onDragStart}
  ondragend={onDragEnd}
>
  <Button
    variant="ghost"
    size="compact"
    icon
    class="cursor-grab"
    aria-label={label}
    title={label}
    onkeydown={onKeydown}
  >
    <GripVertical size={14} />
  </Button>
</span>

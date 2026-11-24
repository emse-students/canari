### Fixed - the rail and salon drag zones and the ring's Accept focus no longer depend on Svelte's action order

Svelte 5.59 starts an action before the `{#each}` or `{#if}` it sits beside has rendered, so the drag library configured an empty zone and the ring's Accept lookup found nothing. The zones now configure again when their rows appear (`dndzoneRendered`) and Accept takes the focus when it mounts (`focusOnMount`).

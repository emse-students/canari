<script lang="ts">
  /**
   * THE MINER'S LAMP (owner, 2026-11-27): the hint is a lamp, not a bulb. A safety lamp - a glass cage between
   * two brass rings - whose flame burns while a hint is shown (`lit`). Drawn once and used by the tutorial's
   * "Indice" button AND the unranked game's hint button, so the app says the same thing everywhere. Decorative:
   * the button that wears it carries the label. Colours are the fixed `--color-pic-*` tokens.
   */
  interface Props {
    /** The flame burns, and the glass glows. */
    lit?: boolean;
    /** Height in px; the width follows the drawing's 40:72 ratio. */
    size?: number;
    class?: string;
  }

  let { lit = false, size = 40, class: className = '' }: Props = $props();
</script>

<svg
  viewBox="0 0 40 72"
  width={Math.round((size * 40) / 72)}
  height={size}
  aria-hidden="true"
  class="shrink-0 {className}"
  data-lit={lit}
>
  <circle style="stroke: var(--color-pic-iron)" cx="20" cy="5" r="3" fill="none" stroke-width="1.8"
  ></circle>
  <ellipse style="fill: var(--color-pic-metal-dark)" cx="20" cy="10" rx="11" ry="2.5"></ellipse>
  <polygon style="fill: var(--color-pic-metal)" points="11,10 29,10 30,32 10,32"></polygon>
  <polygon style="fill: var(--color-pic-metal-lit)" points="13,10 16.5,10 16,32 12,32"></polygon>
  <rect style="fill: var(--color-pic-pupil)" x="13.5" y="13" width="3" height="3.5" rx="1"></rect>
  <rect style="fill: var(--color-pic-pupil)" x="18.5" y="13" width="3" height="3.5" rx="1"></rect>
  <rect style="fill: var(--color-pic-pupil)" x="23.5" y="13" width="3" height="3.5" rx="1"></rect>
  <rect style="fill: var(--color-pic-gold-dark)" x="9" y="32" width="22" height="3" rx="1"></rect>
  <rect
    x="11"
    y="35"
    width="18"
    height="15"
    style={`fill: var(--color-pic-${lit ? 'glass-lit' : 'glass'})`}
  ></rect>
  <path
    style="fill: var(--color-pic-flame)"
    d="M20 38 Q24.5 44 20 48.5 Q15.5 44 20 38"
    opacity={lit ? 1 : 0}
  ></path>
  <path
    style="fill: var(--color-pic-flame-core)"
    d="M20 42 Q22 45 20 47.5 Q18 45 20 42"
    opacity={lit ? 1 : 0}
  ></path>
  <line
    style="stroke: var(--color-pic-gold-dark)"
    x1="14"
    y1="35"
    x2="14"
    y2="50"
    stroke-width="1.6"
  ></line>
  <line
    style="stroke: var(--color-pic-gold-dark)"
    x1="26"
    y1="35"
    x2="26"
    y2="50"
    stroke-width="1.6"
  ></line>
  <rect style="fill: var(--color-pic-gold-dark)" x="9" y="50" width="22" height="3" rx="1"></rect>
  <polygon style="fill: var(--color-pic-metal)" points="10,53 30,53 31,64 9,64"></polygon>
  <polygon style="fill: var(--color-pic-metal-lit)" points="10,53 15,53 14.5,64 9,64"></polygon>
  <ellipse style="fill: var(--color-pic-gold-dark)" cx="20" cy="58.5" rx="5" ry="2.6"></ellipse>
  <polygon style="fill: var(--color-pic-gold-dark)" points="8,64 32,64 34,69 6,69"></polygon>
</svg>

<script lang="ts" module>
  /** What Le Pic's face says. */
  export type PicMood = 'neutral' | 'happy' | 'think' | 'worried' | 'surprised';
  /** What his arms do: both down, one raised to point, or holding the red flag. */
  export type PicPose = 'rest' | 'point' | 'flag';

  /** The strokes of each mood: the brows, the eyes, the mouth and how much he blushes. */
  const FACES: Record<PicMood, { brows: string; eyes: string; mouth: string; blush: number }> = {
    neutral: {
      brows: 'M78 76 L92 76 M108 76 L122 76',
      eyes: 'M85 86.5 L85 90 M115 86.5 L115 90',
      mouth: 'M94 110 L106 110',
      blush: 0.35,
    },
    happy: {
      brows: 'M78 75 L92 73 M108 73 L122 75',
      eyes: 'M81 90 Q85 85 89 90 M111 90 Q115 85 119 90',
      mouth: 'M92 108.5 Q100 115 108 108.5',
      blush: 0.6,
    },
    think: {
      brows: 'M78 74 L92 77 M108 75 L122 72',
      eyes: 'M86 87 L86 90 M116 86 L116 89',
      mouth: 'M95 111 L106 109',
      blush: 0.35,
    },
    worried: {
      brows: 'M78 77 L92 74 M108 74 L122 77',
      eyes: 'M85 87 L85 90.5 M115 87 L115 90.5',
      mouth: 'M93 112 Q100 107 107 112',
      blush: 0.35,
    },
    surprised: {
      brows: 'M78 73 L92 72 M108 72 L122 73',
      eyes: 'M85 86 L85 91 M115 86 L115 91',
      mouth: 'M100 111 L100 111',
      blush: 0.45,
    },
  };
</script>

<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  /**
   * LE PIC, the minesweeper tutorial's guide (owner, 2026-11-27): a student of the Mines in grand uniform -
   * black tunic, two rows of gold buttons, a white lapel open on one side, epaulettes, belt, a kepi with no
   * insignia, glasses and a thin moustache. One drawing with five moods and three poses; the geometry is the
   * validated design's, copied as it is. Colours are the fixed `--color-pic-*` tokens of `app.css`.
   * docs/wiki/frontend/modules/minesweeper.md, "The tutorial path"
   */
  interface Props {
    mood?: PicMood;
    pose?: PicPose;
    /** Width in px; the height follows the drawing's 220:240 ratio. */
    size?: number;
    class?: string;
  }

  let { mood = 'happy', pose = 'rest', size = 220, class: className = '' }: Props = $props();

  const face = $derived(FACES[mood] ?? FACES.happy);
  const rest = $derived(pose === 'rest' ? 1 : 0);
  const point = $derived(pose === 'point' ? 1 : 0);
  const flag = $derived(pose === 'flag' ? 1 : 0);
</script>

<svg
  viewBox="0 0 220 240"
  width={size}
  height={Math.round((size * 240) / 220)}
  role="img"
  aria-label={m.minesweeper_pic_label()}
  class="shrink-0 {className}"
  data-mood={mood}
  data-pose={pose}
>
  <polygon style="fill: var(--color-pic-sleeve)" points="46,144 60,154 50,226 32,222"></polygon>
  <polygon style="fill: var(--color-pic-gold)" points="32,222 50,226 49,232 31,229"></polygon>
  <circle style="fill: var(--color-pic-skin)" cx="40" cy="236" r="8"></circle>

  <polygon
    style="fill: var(--color-pic-sleeve)"
    points="154,144 140,154 150,226 168,222"
    opacity={rest}
  ></polygon>
  <polygon
    style="fill: var(--color-pic-gold-shade)"
    points="168,222 150,226 151,232 169,229"
    opacity={rest}
  ></polygon>
  <circle style="fill: var(--color-pic-skin-shade)" cx="160" cy="236" r="8" opacity={rest}></circle>

  <polygon
    style="fill: var(--color-pic-tunic)"
    points="46,146 66,134 134,134 154,146 150,240 50,240"
  ></polygon>
  <polygon style="fill: var(--color-pic-tunic-lit)" points="100,134 134,134 154,146 150,240 100,240"
  ></polygon>

  <polygon style="fill: var(--color-pic-lapel)" points="98,139 130,145 91,214"></polygon>
  <polygon style="fill: var(--color-pic-lapel-shade)" points="113,142 130,145 91,214"></polygon>
  <line style="stroke: var(--color-pic-ink)" x1="98" y1="139" x2="91" y2="214" stroke-width="1.4"
  ></line>
  <circle style="fill: var(--color-pic-gold)" cx="63" cy="152" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold)" cx="66" cy="168" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold)" cx="69" cy="184" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold)" cx="72" cy="200" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold)" cx="75" cy="214" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold-shade)" cx="137" cy="152" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold-shade)" cx="134" cy="168" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold-shade)" cx="131" cy="184" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold-shade)" cx="128" cy="200" r="3.6"></circle>
  <circle style="fill: var(--color-pic-gold-shade)" cx="125" cy="214" r="3.6"></circle>
  <polygon style="fill: var(--color-pic-belt)" points="50,219 150,219 150,229 50,229"></polygon>
  <line
    style="stroke: var(--color-pic-metal-dark)"
    x1="50"
    y1="220"
    x2="150"
    y2="220"
    stroke-width="1"
  ></line>
  <path
    style="stroke: var(--color-pic-gold)"
    d="M93 224 Q100 228 107 224"
    stroke-width="1.6"
    fill="none"
  ></path>
  <circle
    style="fill: var(--color-pic-gold); stroke: var(--color-pic-gold-dark)"
    cx="88"
    cy="224"
    r="6.2"
    stroke-width="1.4"
  ></circle>
  <circle style="fill: var(--color-pic-gold-shade)" cx="88" cy="224" r="2.4"></circle>
  <circle
    style="fill: var(--color-pic-gold-shade); stroke: var(--color-pic-gold-dark)"
    cx="112"
    cy="224"
    r="6.2"
    stroke-width="1.4"
  ></circle>
  <circle style="fill: var(--color-pic-gold-dark)" cx="112" cy="224" r="2.4"></circle>

  <polygon
    style="fill: var(--color-pic-sleeve); stroke: var(--color-pic-sleeve)"
    points="140,136 182,118 192,94 206,98 198,136 160,162 146,158"
    stroke-width="2"
    stroke-linejoin="round"
    opacity={point}
  ></polygon>
  <polygon
    style="fill: var(--color-pic-gold-shade)"
    points="191,98 205,102 207,96 193,92"
    opacity={point}
  ></polygon>
  <circle style="fill: var(--color-pic-skin)" cx="200" cy="86" r="9" opacity={point}></circle>
  <polygon style="fill: var(--color-pic-skin)" points="197,78 201,62 207,63 205,80" opacity={point}
  ></polygon>

  <line
    style="stroke: var(--color-pic-pole)"
    x1="192"
    y1="16"
    x2="192"
    y2="98"
    stroke-width="4"
    stroke-linecap="round"
    opacity={flag}
  ></line>
  <polygon style="fill: var(--color-pic-flag)" points="194,16 194,44 218,30" opacity={flag}
  ></polygon>
  <polygon style="fill: var(--color-pic-flag-shade)" points="194,30 194,44 218,30" opacity={flag}
  ></polygon>
  <polygon
    style="fill: var(--color-pic-sleeve); stroke: var(--color-pic-sleeve)"
    points="140,136 176,118 184,78 198,80 194,134 160,162 146,158"
    stroke-width="2"
    stroke-linejoin="round"
    opacity={flag}
  ></polygon>
  <polygon
    style="fill: var(--color-pic-gold-shade)"
    points="183,80 198,82 199,76 184,74"
    opacity={flag}
  ></polygon>
  <circle style="fill: var(--color-pic-skin)" cx="192" cy="68" r="9" opacity={flag}></circle>

  <path
    style="stroke: var(--color-pic-gold)"
    d="M52 143 L68 134"
    stroke-width="4"
    stroke-linecap="round"
  ></path>
  <circle
    style="stroke: var(--color-pic-gold)"
    cx="48"
    cy="147"
    r="4.4"
    fill="none"
    stroke-width="2.6"
  ></circle>
  <path
    style="stroke: var(--color-pic-gold-shade)"
    d="M148 143 L132 134"
    stroke-width="4"
    stroke-linecap="round"
  ></path>
  <circle
    style="stroke: var(--color-pic-gold-shade)"
    cx="152"
    cy="147"
    r="4.4"
    fill="none"
    stroke-width="2.6"
  ></circle>

  <polygon style="fill: var(--color-pic-skin-neck)" points="88,112 112,112 112,128 88,128"
  ></polygon>
  <polygon style="fill: var(--color-pic-tunic)" points="74,124 126,124 130,142 70,142"></polygon>
  <ellipse
    style="fill: var(--color-pic-gold)"
    cx="80"
    cy="133"
    rx="4.5"
    ry="2.4"
    transform="rotate(-30 80 133)"
  ></ellipse>
  <ellipse
    style="fill: var(--color-pic-gold)"
    cx="86"
    cy="129"
    rx="4.5"
    ry="2.4"
    transform="rotate(20 86 129)"
  ></ellipse>
  <ellipse
    style="fill: var(--color-pic-gold)"
    cx="88"
    cy="136"
    rx="4"
    ry="2.2"
    transform="rotate(-10 88 136)"
  ></ellipse>
  <ellipse
    style="fill: var(--color-pic-gold-shade)"
    cx="120"
    cy="133"
    rx="4.5"
    ry="2.4"
    transform="rotate(30 120 133)"
  ></ellipse>
  <ellipse
    style="fill: var(--color-pic-gold-shade)"
    cx="114"
    cy="129"
    rx="4.5"
    ry="2.4"
    transform="rotate(-20 114 129)"
  ></ellipse>
  <ellipse
    style="fill: var(--color-pic-gold-shade)"
    cx="112"
    cy="136"
    rx="4"
    ry="2.2"
    transform="rotate(10 112 136)"
  ></ellipse>
  <polygon
    style="fill: var(--color-pic-skin)"
    points="66,62 134,62 136,96 120,118 100,124 80,118 64,96"
  ></polygon>
  <polygon style="fill: var(--color-pic-skin-shade)" points="100,62 134,62 136,96 120,118 100,124"
  ></polygon>
  <polygon style="fill: var(--color-pic-skin-neck)" points="64,80 58,84 60,94 65,96"></polygon>
  <polygon style="fill: var(--color-pic-skin-ear)" points="136,80 142,84 140,94 135,96"></polygon>
  <polygon style="fill: var(--color-pic-hair)" points="64,68 80,68 75,74 69,80 64,84 63,76"
  ></polygon>
  <polygon
    style="fill: var(--color-pic-hair-shade)"
    points="136,68 120,68 125,74 131,80 136,84 137,76"
  ></polygon>
  <circle style="fill: var(--color-pic-blush)" cx="82" cy="104" r="5" opacity={face.blush}></circle>
  <circle style="fill: var(--color-pic-blush)" cx="118" cy="104" r="5" opacity={face.blush}
  ></circle>
  <path
    style="stroke: var(--color-pic-hair)"
    d={face.brows}
    stroke-width="3"
    stroke-linecap="round"
    fill="none"
  ></path>
  <rect
    style="fill: var(--color-pic-lens); stroke: var(--color-pic-iron)"
    x="73"
    y="81"
    width="24"
    height="14"
    rx="3"
    fill-opacity="0.3"
    stroke-width="2.2"
  ></rect>
  <rect
    style="fill: var(--color-pic-lens); stroke: var(--color-pic-iron)"
    x="103"
    y="81"
    width="24"
    height="14"
    rx="3"
    fill-opacity="0.3"
    stroke-width="2.2"
  ></rect>
  <line style="stroke: var(--color-pic-iron)" x1="97" y1="86" x2="103" y2="86" stroke-width="2.2"
  ></line>
  <path
    style="stroke: var(--color-pic-pupil)"
    d={face.eyes}
    stroke-width="3.4"
    stroke-linecap="round"
    fill="none"
  ></path>
  <path
    style="stroke: var(--color-pic-hair)"
    d="M90 104.5 Q95 101.5 100 103 Q105 101.5 110 104.5"
    stroke-width="2.4"
    stroke-linecap="round"
    fill="none"
  ></path>
  <path
    style="stroke: var(--color-pic-mouth)"
    d={face.mouth}
    stroke-width="2.6"
    stroke-linecap="round"
    fill="none"
  ></path>
  <ellipse
    style="fill: var(--color-pic-mouth-open); stroke: var(--color-pic-mouth)"
    cx="100"
    cy="111.5"
    rx="4.5"
    ry="5.5"
    stroke-width="1.5"
    opacity={mood === 'surprised' ? 1 : 0}
  ></ellipse>
  <polygon
    style="fill: var(--color-pic-hair)"
    points="68,70 132,70 129,77 120,73.5 111,78 101,73.5 91,78 81,73.5 72,77"
  ></polygon>
  <line
    style="stroke: var(--color-pic-pupil)"
    x1="73"
    y1="81.5"
    x2="97"
    y2="81.5"
    stroke-width="3.6"
    stroke-linecap="round"
  ></line>
  <line
    style="stroke: var(--color-pic-pupil)"
    x1="103"
    y1="81.5"
    x2="127"
    y2="81.5"
    stroke-width="3.6"
    stroke-linecap="round"
  ></line>

  <polygon style="fill: var(--color-pic-tunic)" points="68,14 132,14 136,56 64,56"></polygon>
  <polygon style="fill: var(--color-pic-tunic-lit)" points="100,14 132,14 136,56 100,56"></polygon>
  <polygon style="fill: var(--color-pic-gold)" points="64,52 136,52 136,62 64,62"></polygon>
  <polygon style="fill: var(--color-pic-gold-shade)" points="100,52 136,52 136,62 100,62"></polygon>
  <polygon style="fill: var(--color-pic-ink)" points="60,62 140,62 132,71 68,71"></polygon>
  <polygon style="fill: var(--color-pic-cap-top)" points="68,14 132,14 133,24 67,24"></polygon>
  <polygon style="fill: var(--color-pic-cap-top-shade)" points="100,14 132,14 133,24 100,24"
  ></polygon>
  <polygon style="fill: var(--color-pic-gold)" points="67,24 133,24 133.3,27 66.7,27"></polygon>
</svg>

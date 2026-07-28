/**
 * One-way colour detector (WP-UI-1).
 *
 * A light-mode-only utility is a bug when nothing in the SAME class list flips it for dark mode:
 * `bg-white` does not flip, while the `text-text-main` sitting on it does - white on white. The fix
 * is an `app.css` token (`bg-cn-surface`, `text-red-err`, `text-green-ok`, `text-amber-warn`, ...),
 * which flips on its own, tinted with an opacity modifier where a pale shade is wanted.
 *
 * Two traps this script exists to avoid:
 *
 *  1. **Detection is per class list, not per file.** `bg-white dark:bg-slate-900` is perfectly fine.
 *     A plain grep over-reports by roughly 4x.
 *  2. **Do NOT tokenize on `:`.** That strips the `dark:` prefix off every counterpart and makes
 *     every correctly-paired utility look one-way. Ternary colons are surrounded by spaces, so
 *     they split fine without it.
 *
 * Deliberately NOT reported, because they are theme-neutral by construction rather than one-way:
 *  - anything `black`: a scrim (`bg-black/40`) is meant to darken whatever is behind it.
 *  - `bg-white/N` and `border-white/N` with N <= 20: the glassmorphism highlight idiom, which sits
 *    on a glass surface and reads correctly in both themes.
 *
 * Usage: `node scripts/find-oneway-colors.mjs [pathFilter]` from `frontend/`.
 * A path filter also prints the offending tokens line by line.
 */
import { readFileSync, globSync } from 'node:fs';

const PALETTE =
  '(?:red|amber|green|blue|orange|emerald|yellow|purple|indigo|slate|gray|neutral|stone|zinc|teal|cyan|rose|pink|lime|violet|sky|fuchsia)';

/** Opacity at or below which a white utility reads as a glass highlight rather than a surface. */
const GLASS_MAX_OPACITY = 20;

/** CSS property group -> regex matching a one-way utility of that group. */
const RULES = [
  ['bg', new RegExp(`^-?bg-(?:white|${PALETTE}-(?:50|100|200))(?:\\/\\d+)?$`)],
  // 600 counts: `text-red-600` reads fine on a light card but drops to ~3.9:1 once the card
  // flips, where `text-red-err` (which flips too) stays above 7:1.
  ['text', new RegExp(`^-?text-(?:${PALETTE}-(?:600|700|800|900))(?:\\/\\d+)?$`)],
  ['border', new RegExp(`^-?border-(?:white|${PALETTE}-(?:100|200))(?:\\/\\d+)?$`)],
];

/** Raw hex colours (arbitrary values) - they can never flip and they drift from the tokens. */
const HEX = /\[#[0-9a-fA-F]{3,8}\]/;

/** True for the low-opacity white overlays that are a deliberate glass idiom, not a surface. */
function isGlassOverlay(token) {
  const match = /^(?:bg|border)-white\/(\d+)$/.exec(token);
  return match !== null && Number(match[1]) <= GLASS_MAX_OPACITY;
}

/**
 * Extracts every class attribute in a Svelte source, including `class={...}` expressions, which
 * are matched brace-balanced so a ternary is captured whole.
 */
function classAttributes(src) {
  const out = [];
  const re = /class(?:Name)?\s*=\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const i = m.index + m[0].length;
    if (src[i] === '"' || src[i] === "'") {
      const end = src.indexOf(src[i], i + 1);
      if (end < 0) continue;
      out.push({ text: src.slice(i + 1, end), index: i });
      re.lastIndex = end;
    } else if (src[i] === '{') {
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      out.push({ text: src.slice(i + 1, j), index: i });
      re.lastIndex = j;
    }
  }
  return out;
}

const findings = [];
for (const file of globSync('src/**/*.svelte')) {
  const src = readFileSync(file, 'utf8');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  for (const attr of classAttributes(src)) {
    const tokens = attr.text.split(/[\s'"`,?{}()]+/).filter(Boolean);
    const hasDark = new Set(
      tokens.filter((t) => t.startsWith('dark:')).map((t) => t.slice(5).split('-')[0])
    );
    const bad = [];
    for (const token of tokens) {
      if (token.includes(':') && !token.startsWith('-')) continue; // variant-prefixed: its own group
      if (isGlassOverlay(token)) continue;
      for (const [group, re] of RULES) {
        if (re.test(token) && !hasDark.has(group)) bad.push(token);
      }
    }
    if (HEX.test(attr.text)) bad.push(HEX.exec(attr.text)[0]);
    if (bad.length) findings.push({ file, line: lineOf(attr.index), tokens: [...new Set(bad)] });
  }
}

const byFile = new Map();
for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + f.tokens.length);
const total = findings.reduce((a, f) => a + f.tokens.length, 0);

console.log(`files: ${byFile.size}  occurrences: ${total}\n`);
for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(4), file);
}

const filter = process.argv[2];
if (filter) {
  console.log('\n--- detail ---');
  for (const f of findings.filter((f) => f.file.includes(filter))) {
    console.log(`${f.file}:${f.line}  ${f.tokens.join(' ')}`);
  }
}

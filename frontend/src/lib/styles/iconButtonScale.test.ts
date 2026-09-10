/**
 * ONE ICON BUTTON IS THE SAME SIZE AS THE NEXT ONE, OR THIS FAILS.
 *
 * Measured on ONE screen of `/chat` at 1280px on 2026-09-09: 163 icon-only buttons visible at
 * once, in FOUR sizes - the conversation header at 40px, the composer's paperclip and its send
 * button at 36px, "Nouvelle discussion" in the sidebar at 32px, "Repondre" on the message hover
 * strip at 28px. Four gaps of four pixels, side by side. Small enough that nobody chose them -
 * each button was written against the one neighbour its author had in mind - and large enough to
 * see where two surfaces touch. The user was shown that table and took the decision (*"Poser la
 * reference ET tout aligner maintenant"*): 28px for a control that appears on hover inside a dense
 * row, 38px for everything else, with a 44px touch form because 38 is under every platform's
 * target and the composer was already paying that difference by hand.
 *
 * NOTHING WOULD HAVE REPORTED THOSE FOUR SIZES. `bun run check` answers 0 errors, `oxlint` is
 * silent, and `utilityScale.test.ts` next door keeps arbitrary numbers off the CORNERS while
 * saying nothing about the box. This is the same instrument aimed at the box: a fifth size is a
 * distinction the design does not make, and it must fail rather than ship.
 *
 * THE CLAIM IS DELIBERATELY NARROW, AND IT IS A RULE RATHER THAN A LIST: an icon-only `<button>`
 * that DECLARES A BOX must declare it through `.ui-icon-button`. A button that declares no box is
 * left alone on purpose - the 12px pencil in a comment's meta row beside a text "Repondre", the
 * cross inside a co-owner chip, the avatar in the navbar, the clear-X inside a search field. Their
 * author gave them no box, a 44px one would blow their row apart, and a sweep that could not tell
 * the difference is what makes a codemod dangerous.
 *
 * WHAT THE EXCEPTIONS ARE FOR, and each is measured against a neighbour rather than against this
 * scale: a cross on a 64px thumbnail, a zoom control floating over the minesweeper board, the
 * camera badge on an avatar, the 48px community rail, a play button matched to the height of its
 * own bubble. Held BY FILE AND BY COUNT so the list cannot go stale in either direction - a new
 * unswept button in one of these files fails, and so does an entry whose buttons have gone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cssPath = join(src, 'app.css');

/**
 * Boxed icon buttons whose size is dictated by what they sit on, by file and exact count.
 *
 * A COUNT AND NOT A LINE NUMBER: lines move on every edit above them, counts move only when a
 * button is added or removed - which is exactly when someone should be asked to justify it again.
 */
const SIZED_BY_A_NEIGHBOUR: Record<string, { count: number; why: string }> = {
  'lib/components/chat/CallOverlay.svelte': {
    count: 15,
    why: 'the primary controls of a full-screen call, not a row of secondary actions; and CALLS_ENABLED is false, so nothing here can be looked at while it changes',
  },
  'lib/components/chat/ChatComposer.svelte': {
    count: 2,
    why: 'crosses overlaying a 64px media thumbnail',
  },
  'lib/components/messages/MessageBubbleToolbar.svelte': {
    count: 1,
    why: 'matched to the quick-reaction emoji buttons beside it',
  },
  'lib/components/messages/MessageMediaRenderer.svelte': {
    count: 2,
    why: 'overlays an image and must not cover it',
  },
  'lib/components/messages/MessageMobileActions.svelte': {
    count: 1,
    why: 'matched to the emoji row of the mobile action sheet',
  },
  'lib/components/messages/VoiceMessagePlayer.svelte': {
    count: 2,
    why: 'matched to the height of its own bubble and to the speed pill',
  },
  'lib/components/posts/PostComments.svelte': {
    count: 1,
    why: '16px cross on an attachment chip',
  },
  'lib/components/posts/PostMedia.svelte': {
    count: 1,
    why: 'overlays a video and must not cover it',
  },
  'lib/components/settings/MinesweeperModal.svelte': {
    count: 3,
    why: 'zoom controls floating over the board',
  },
  'lib/components/shared/PermissionGrid.svelte': { count: 1, why: 'a cell of a grid' },
  'lib/components/sidebar/Sidebar.svelte': { count: 2, why: 'the 48px community rail tiles' },
  'routes/profile/+page.svelte': { count: 1, why: 'the camera badge pinned to the avatar' },
};

/** Classes that declare a box in `app.css` under their own name. */
const BOXED_CLASSES = [
  'chat-composer-icon-button',
  'chat-composer-send-button',
  'chat-search-action',
];

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, out);
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out;
}

const ALL_FILES = svelteFiles(join(src, 'lib')).concat(svelteFiles(join(src, 'routes')));

/** A `<button>` opening tag with the span of its body. */
interface ButtonTag {
  line: number;
  attrs: string;
  body: string;
}

/**
 * Every `<button ...>...</button>` in a source file.
 *
 * BRACE-AWARE, AND THAT IS NOT A DETAIL: `onclick={() => save()}` contains a `>`, so a scanner
 * that stops at the first one cuts the opening tag in half and reads the rest of the attributes
 * as body. A first draft of this reader did, and undercounted the tree by two thirds.
 */
function buttonsIn(source: string): ButtonTag[] {
  const found: ButtonTag[] = [];
  const open = /<button\b/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(source))) {
    let i = m.index + 7;
    let quote: string | null = null;
    let brace = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '{') brace++;
      else if (c === '}') brace--;
      else if (c === '>' && brace === 0) break;
    }
    const attrs = source.slice(m.index, i);
    if (attrs.trimEnd().endsWith('/')) continue;

    let depth = 1;
    const tag = /<\/?button\b/g;
    tag.lastIndex = i + 1;
    let t: RegExpExecArray | null;
    let close = -1;
    while ((t = tag.exec(source))) {
      depth += source[t.index + 1] === '/' ? -1 : 1;
      if (depth === 0) {
        close = t.index;
        break;
      }
    }
    if (close === -1) continue;
    found.push({
      line: source.slice(0, m.index).split('\n').length,
      attrs,
      body: source.slice(i + 1, close),
    });
  }
  return found;
}

/**
 * Is this body an icon and nothing a reader would read?
 *
 * Icons become a marker rather than disappearing, so "was there an icon at all" and "is anything
 * else left" stay two separate questions - a `<button>` holding only text must not qualify.
 */
/**
 * A SENTINEL NO MARKUP CAN CONTAIN, spelled so a reader can see it. It must not be the empty
 * string: replacing an icon with '' deletes it, and then "was there an icon" is answered by
 * counting characters, so a body of pure whitespace reads as an icon.
 */
const MARK = '@@ICON@@';
function isIconOnly(body: string): boolean {
  let s = body;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/g, MARK);
  s = s.replace(/<[A-Z][\w.]*\b[^>]*\/>/g, MARK);
  s = s.replace(/<span\b[^>]*sr-only[^>]*>[\s\S]*?<\/span>/g, '');
  s = s.replace(/<\/?(span|div|slot)\b[^>]*>/g, '');
  s = s.replace(/\{#if[^}]*\}|\{:else[^}]*\}|\{\/if\}|\{#key[^}]*\}|\{\/key\}/g, '');
  const icons = s.split(MARK).length - 1;
  return icons >= 1 && s.split(MARK).join('').trim() === '';
}

const withoutVariant = (token: string): string => token.replace(/^(?:[a-z0-9-]+:)+/, '');
const SYMMETRIC_PADDING = /^p-[\d.]+$/;
const EXPLICIT_BOX = /^(?:h|w|size)-[\d.]+$/;
const ASYMMETRIC_PADDING = /^p[xytblrse]-/;

interface Site {
  file: string;
  line: number;
  classes: string;
  tokens: string[];
}

/** Every icon-only button in the tree, with its class tokens. */
const ICON_BUTTONS: Site[] = ALL_FILES.flatMap((full) => {
  const source = readFileSync(full, 'utf8');
  const file = relative(src, full).replace(/\\/g, '/');
  return buttonsIn(source)
    .filter((b) => isIconOnly(b.body))
    .map((b) => {
      const cm = /\bclass="([^"]*)"/.exec(b.attrs);
      const classes = cm ? cm[1] : '';
      return { file, line: b.line, classes, tokens: classes.split(/\s+/).filter(Boolean) };
    });
});

const onTheClass = (s: Site): boolean => s.tokens.includes('ui-icon-button');
const declaresABox = (s: Site): boolean =>
  s.tokens.some(
    (t) =>
      BOXED_CLASSES.includes(t) ||
      SYMMETRIC_PADDING.test(withoutVariant(t)) ||
      EXPLICIT_BOX.test(withoutVariant(t))
  );

describe('the icon-button box', () => {
  it('finds the population at all, so a silent reader failure cannot pass as a clean tree', () => {
    // Not an assertion about the exact number - it moves with every feature. It asserts the READER
    // still works: a regex that quietly matches nothing reports a perfectly aligned tree.
    expect(ICON_BUTTONS.length).toBeGreaterThan(120);
  });

  it('declares exactly two sizes, and a 44px touch form of the larger one', () => {
    // COMMENTS OUT FIRST. The block above `.ui-icon-button` explains the 2.25rem the composer used
    // to declare, and a rule about declared widths that counts the ones in its own explanation is
    // measuring prose. `utilityScale.test.ts` next door strips them for the same reason.
    const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const widths = [...css.matchAll(/\.ui-icon-button[^{]*\{[^}]*?width:\s*([\d.]+rem)/g)].map(
      (m) => m[1]
    );

    expect(widths.length, 'no .ui-icon-button rule declares a width - the class was gutted').toBe(
      3
    );
    // 2.75rem (44px touch), 2.375rem (38px pointer), 1.75rem (28px hover strip). A fourth value is
    // the fifth size the design does not make.
    expect(new Set(widths), `widths declared for .ui-icon-button: ${widths.join(', ')}`).toEqual(
      new Set(['2.75rem', '2.375rem', '1.75rem'])
    );
  });

  it('has no icon button declaring a box of its own outside the ones measured against a neighbour', () => {
    const offenders = ICON_BUTTONS.filter((s) => !onTheClass(s) && declaresABox(s));

    const byFile = new Map<string, Site[]>();
    for (const s of offenders) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);

    const unexplained: string[] = [];
    for (const [file, sites] of byFile) {
      const allowed = SIZED_BY_A_NEIGHBOUR[file];
      if (!allowed) {
        unexplained.push(
          `${file}: ${sites.length} icon button(s) sizing themselves - lines ${sites.map((s) => s.line).join(', ')}`
        );
      } else if (allowed.count !== sites.length) {
        unexplained.push(
          `${file}: ${sites.length} sizing themselves, ${allowed.count} are explained (${allowed.why}) - lines ${sites.map((s) => s.line).join(', ')}`
        );
      }
    }

    expect(
      unexplained,
      'An icon-only button that declares a box must declare it with `ui-icon-button` (44px touch, ' +
        '38px pointer) or `ui-icon-button ui-icon-button--sm` (28px, pointer-only rows). If its ' +
        'size is really dictated by what it sits on - a thumbnail, an avatar, a grid cell - add it ' +
        'to SIZED_BY_A_NEIGHBOUR above with the reason.\n' +
        unexplained.join('\n')
    ).toEqual([]);
  });

  it('keeps every exception honest - an entry whose buttons are gone is a stale claim', () => {
    const boxedOffFile = new Set(
      ICON_BUTTONS.filter((s) => !onTheClass(s) && declaresABox(s)).map((s) => s.file)
    );
    const stale = Object.keys(SIZED_BY_A_NEIGHBOUR).filter((f) => !boxedOffFile.has(f));

    expect(
      stale,
      'These files no longer contain a self-sizing icon button, so their exception says nothing. ' +
        'Delete the entry.\n' +
        stale.join('\n')
    ).toEqual([]);
  });

  it('never lets a call site re-declare the box it just took from the class', () => {
    const offenders = ICON_BUTTONS.filter(
      (s) =>
        onTheClass(s) &&
        s.tokens.some(
          (t) =>
            SYMMETRIC_PADDING.test(withoutVariant(t)) ||
            EXPLICIT_BOX.test(withoutVariant(t)) ||
            ASYMMETRIC_PADDING.test(withoutVariant(t))
        )
    );

    expect(
      offenders.map((s) => `${s.file}:${s.line}  ${s.classes}`),
      'A padding or a size beside `ui-icon-button` is a fifth box wearing the class name. Remove it.'
    ).toEqual([]);
  });
});

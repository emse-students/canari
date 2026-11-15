/**
 * AT ANDROID'S 200 % TEXT, NO GLYPH IN THE AGENDA OUTGROWS A FIXED BOX.
 *
 * The WebView multiplies font sizes and leaves lengths alone (`lib/utils/textZoom.ts`), so a box
 * sized on the spacing scale around text sized on the type scale is overrun at 200 %. The Mi 9T read
 * two such overruns in `/calendar` on 2026-10-13: today's day number (40px) in its fixed 36px circle,
 * and "S'abonner au calendrier" held at its full width by `shrink-0`, spilling 33 px out of its card.
 *
 * The rule asserted, over every agenda surface: an element that declares BOTH a fixed square box
 * (`h-N w-N` or `size-N`) and a type-scale size must size the box with `text-zoom-size-N`, which
 * follows `--text-zoom`. A glyph that is a mark rather than reading text takes `.text-zoom-exempt`
 * on its own span instead, and then declares no type size on the box. And the page's actions never
 * refuse to shrink.
 */
import { describe, it, expect } from 'vitest';
import { withoutComments } from './markupSources';
import { svelteSources } from './markupTree';
import { readSource, relativeTo } from '../../test/sourceTree';

const src = 'src';

const AGENDA_DIRS = ['lib/components/calendar', 'routes/calendar'];

/** Every static `class="..."` value of a file, comments removed. */
function classValues(file: string): string[] {
  const body = withoutComments(readSource(file));
  return [...body.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
}

const FIXED_SQUARE = /(?:^|\s)(?:size-\d+(?:\.\d+)?|h-(\d+(?:\.\d+)?)\s(?:[^"]*\s)?w-\1)(?:\s|$)/;
const TYPE_SIZE = /(?:^|\s)text-(?:2xs|xs|sm|base|lg|xl|2xl|3xl)(?:\s|$)/;

describe('the agenda at 200 % text', () => {
  it('reads the tree it thinks it does: the agenda directories are in the scan', () => {
    const files = AGENDA_DIRS.flatMap((dir) => svelteSources(`${src}/${dir}`).map((f) => f.path));
    expect(files).toContain(`${src}/lib/components/calendar/CalendarScheduleList.svelte`);
    expect(files).toContain(`${src}/routes/calendar/+page.svelte`);
  });

  it('sizes every fixed box that holds type-scale text by the text zoom', () => {
    const offenders: string[] = [];
    for (const dir of AGENDA_DIRS) {
      for (const { path: file } of svelteSources(`${src}/${dir}`)) {
        for (const value of classValues(file)) {
          if (FIXED_SQUARE.test(value) && TYPE_SIZE.test(value)) {
            offenders.push(`${relativeTo(file, src)}: ${value.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('draws the day number in a circle that grows with it', () => {
    const values = classValues(`${src}/lib/components/calendar/CalendarScheduleList.svelte`);
    expect(values.some((v) => /text-zoom-size-9/.test(v) && /rounded-full/.test(v))).toBe(true);
    expect(values.some((v) => /(?:^|\s)text-zoom-w-11(?:\s|$)/.test(v))).toBe(true);
  });

  it('lets the page actions shrink and wrap their label rather than leave their card', () => {
    const values = classValues(`${src}/routes/calendar/+page.svelte`).filter(
      (v) => /(?:^|\s)rounded-xl(?:\s|$)/.test(v) && /(?:^|\s)inline-flex(?:\s|$)/.test(v)
    );
    expect(values.length).toBeGreaterThanOrEqual(3);
    for (const value of values) {
      expect(value).not.toMatch(/(?:^|\s)shrink-0(?:\s|$)/);
      expect(value).toMatch(/(?:^|\s)max-w-full(?:\s|$)/);
    }
  });
});

describe('the post comment controls at 200 % text', () => {
  it('wraps the sort row instead of widening the page', () => {
    // The show/hide toggle left this row with the inline thread (the thread is a sheet now): what
    // remains is the three sort buttons, which must still wrap when the text is doubled.
    const values = classValues(`${src}/lib/components/posts/PostComments.svelte`);
    const row = values.find(
      (v) => /(?:^|\s)justify-end(?:\s|$)/.test(v) && /(?:^|\s)mb-2(?:\s|$)/.test(v)
    );
    expect(row).toMatch(/(?:^|\s)flex-wrap(?:\s|$)/);
  });
});

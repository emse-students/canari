import { resolve } from '$app/paths';
import { m } from '$lib/paraglide/messages';
import { LESSONS, type Lesson } from './lessons';
import { PATTERNS } from './patterns';

/**
 * THE TUTORIAL PATH (owner, 2026-11-27): the two lists the path draws, as TABS - "Les bases" (the lessons of
 * `lessons.ts`) and "Motifs" (the catalogue of `patterns.ts`) - each cut into FAMILIES.
 *
 * **The order is advised and EVERYTHING STAYS OPEN**: nothing here locks a lesson. A family is the lessons
 * that follow each other under one heading (the catalogue's `section`; the basics are one family), and the
 * "current" lesson of a tab is only the first one not done, the one the "Continue" button leads to.
 */
export type TutorialTab = 'basics' | 'patterns';

export const TUTORIAL_TABS: readonly TutorialTab[] = ['basics', 'patterns'];

/** A run of lessons under one heading, in the order the path draws them. */
export interface PathFamily {
  /** Stable within a tab: the position of the family. */
  key: string;
  label: () => string;
  lessons: readonly Lesson[];
}

/** Cuts a list into families: consecutive lessons sharing a `section` (the catalogue keeps them together). */
function familiesOf(lessons: readonly Lesson[], fallback: () => string): PathFamily[] {
  const families: { key: string; label: () => string; lessons: Lesson[] }[] = [];
  let currentSection: Lesson['section'] | null = null;
  for (const lesson of lessons) {
    const last = families.at(-1);
    if (last && currentSection === lesson.section) {
      last.lessons.push(lesson);
      continue;
    }
    currentSection = lesson.section;
    families.push({
      key: String(families.length),
      label: lesson.section ?? fallback,
      lessons: [lesson],
    });
  }
  return families;
}

/** The families of each tab, in path order. */
export const PATH_FAMILIES: Readonly<Record<TutorialTab, readonly PathFamily[]>> = {
  basics: familiesOf(LESSONS, () => m.minesweeper_path_family_basics()),
  patterns: familiesOf(PATTERNS, () => m.minesweeper_patterns_section_basics()),
};

/** Every lesson of a tab, in path order. */
export function tabLessons(tab: TutorialTab): Lesson[] {
  return PATH_FAMILIES[tab].flatMap((family) => [...family.lessons]);
}

/** Every lesson id the path knows: what a stored progress is validated against. */
export const ALL_LESSON_IDS: ReadonlySet<string> = new Set(
  TUTORIAL_TABS.flatMap((tab) => tabLessons(tab).map((lesson) => lesson.id))
);

/** Where a lesson sits on the path: its tab, its family and its neighbours. */
export interface LessonPlace {
  lesson: Lesson;
  tab: TutorialTab;
  family: PathFamily;
  /** Zero-based position in the family. */
  indexInFamily: number;
  /** The lesson after this one on the path (across families), or null at the end of the tab. */
  next: Lesson | null;
}

/** The path page opened on a tab (`?tab=`), so Back from a lesson lands on the tab the lesson belongs to. */
export function tutorialPathHref(tab: TutorialTab): string {
  return `${resolve('/games/tutorial')}?tab=${tab}`;
}

/** Finds a lesson by id on either tab; null for an id that is not a lesson. */
export function locateLesson(id: string): LessonPlace | null {
  for (const tab of TUTORIAL_TABS) {
    const ordered = tabLessons(tab);
    const at = ordered.findIndex((lesson) => lesson.id === id);
    if (at < 0) continue;
    const lesson = ordered[at];
    const family = PATH_FAMILIES[tab].find((f) => f.lessons.includes(lesson))!;
    return {
      lesson,
      tab,
      family,
      indexInFamily: family.lessons.indexOf(lesson),
      next: ordered[at + 1] ?? null,
    };
  }
  return null;
}

/** The first lesson of a tab not in `done`, the one "Continue" leads to; null when the tab is complete. */
export function firstUndone(tab: TutorialTab, done: ReadonlySet<string>): Lesson | null {
  return tabLessons(tab).find((lesson) => !done.has(lesson.id)) ?? null;
}

/** How many lessons of a list are done. */
export function countDone(lessons: readonly Lesson[], done: ReadonlySet<string>): number {
  return lessons.filter((lesson) => done.has(lesson.id)).length;
}

/**
 * The short name a tile wears: a catalogue title reads "B1 · Autant de cases que de mines", and the tile
 * has room for "B1". A title without that separator is its own short name.
 */
export function shortName(title: string): string {
  const cut = title.indexOf(' · ');
  return cut > 0 ? title.slice(0, cut) : title;
}

/**
 * THE PATH'S SHAPE (owner, 2026-11-27): two tabs, the families of each, and the one rule that matters -
 * the order is advised and nothing is locked, so "current" is only the first lesson not done.
 */
import { describe, expect, it } from 'vitest';
import { LESSONS } from './lessons';
import { PATTERNS } from './patterns';
import {
  ALL_LESSON_IDS,
  PATH_FAMILIES,
  countDone,
  firstUndone,
  locateLesson,
  shortName,
  tabLessons,
} from './path';

describe('the tutorial path', () => {
  it('has the five basics in one family and every catalogue entry, grouped by its sections', () => {
    expect(PATH_FAMILIES.basics).toHaveLength(1);
    expect(tabLessons('basics')).toEqual([...LESSONS]);
    expect(tabLessons('patterns')).toEqual([...PATTERNS]);
    expect(PATH_FAMILIES.patterns.map((f) => f.lessons.length)).toEqual([10, 4, 3, 5, 5, 2]);
    expect(PATH_FAMILIES.patterns.map((f) => f.label()).slice(0, 2)).toEqual([
      'Motifs de base',
      'Réduction',
    ]);
  });

  it('knows every lesson by a unique id', () => {
    expect(ALL_LESSON_IDS.size).toBe(LESSONS.length + PATTERNS.length);
  });

  it('keeps everything open: the first not done is only the advised next, whatever is done', () => {
    const none = new Set<string>();
    expect(firstUndone('basics', none)?.id).toBe(LESSONS[0].id);
    // Skipping ahead does not lock anything, nor move "current" past a hole.
    const skipped = new Set([LESSONS[3].id]);
    expect(firstUndone('basics', skipped)?.id).toBe(LESSONS[0].id);
    expect(firstUndone('basics', new Set(LESSONS.map((l) => l.id)))).toBeNull();
  });

  it('counts what is done within a family', () => {
    const done = new Set([PATTERNS[0].id, PATTERNS[1].id, PATTERNS[12].id]);
    expect(countDone(PATH_FAMILIES.patterns[0].lessons, done)).toBe(2);
    expect(countDone(tabLessons('patterns'), done)).toBe(3);
  });

  it('locates a lesson with its family and the lesson after it, across families', () => {
    const last = PATH_FAMILIES.patterns[0].lessons.at(-1)!;
    const place = locateLesson(last.id)!;
    expect(place.tab).toBe('patterns');
    expect(place.indexInFamily).toBe(9);
    expect(place.next?.id).toBe(PATH_FAMILIES.patterns[1].lessons[0].id);
    expect(locateLesson(LESSONS.at(-1)!.id)!.next).toBeNull();
    expect(locateLesson('nope')).toBeNull();
  });

  it('wears the short name on a tile', () => {
    expect(shortName('B1 · Autant de cases que de mines')).toBe('B1');
    expect(shortName('1-2-1')).toBe('1-2-1');
  });
});

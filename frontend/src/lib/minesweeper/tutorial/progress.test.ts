// @vitest-environment happy-dom
/**
 * THE TUTORIAL'S PROGRESS (owner, 2026-11-27): per device, validated on read like the other minesweeper
 * settings - a value that is not what we wrote is logged and ignored, the path starts blank, nothing breaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LESSONS } from './lessons';
import { PATTERNS } from './patterns';
import {
  TUTORIAL_PROGRESS_KEY,
  loadTutorialProgress,
  markLampUsed,
  markLessonDone,
} from './progress';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the tutorial progress', () => {
  it('starts blank, silently, on a device that never opened the path', () => {
    expect(loadTutorialProgress()).toEqual({ done: [], lampUsed: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('records a lesson done once, in order, and keeps it across reads', () => {
    markLessonDone(LESSONS[0].id);
    markLessonDone(PATTERNS[2].id);
    markLessonDone(LESSONS[0].id);
    expect(loadTutorialProgress().done).toEqual([LESSONS[0].id, PATTERNS[2].id]);
    expect(JSON.parse(localStorage.getItem(TUTORIAL_PROGRESS_KEY)!)).toEqual({
      done: [LESSONS[0].id, PATTERNS[2].id],
      lampUsed: false,
    });
  });

  it('remembers that the lamp was used, without touching the lessons', () => {
    markLessonDone(LESSONS[1].id);
    markLampUsed();
    expect(loadTutorialProgress()).toEqual({ done: [LESSONS[1].id], lampUsed: true });
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '[1,2]'],
    ['a null', 'null'],
    ['a lesson list that is not a list', '{"done":"reveal"}'],
    ['a lesson list holding a number', '{"done":["reveal", 3]}'],
  ])('logs and ignores a stored value that is %s', (_label, stored) => {
    localStorage.setItem(TUTORIAL_PROGRESS_KEY, stored);
    expect(loadTutorialProgress()).toEqual({ done: [], lampUsed: false });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('drops an id that is no lesson any more, and keeps the rest', () => {
    localStorage.setItem(
      TUTORIAL_PROGRESS_KEY,
      JSON.stringify({ done: [LESSONS[0].id, 'a_pattern_we_removed', LESSONS[0].id] })
    );
    expect(loadTutorialProgress().done).toEqual([LESSONS[0].id]);
  });

  it('refuses to record an unknown lesson', () => {
    markLessonDone('nope');
    expect(loadTutorialProgress().done).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('survives a storage that refuses to write', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => markLessonDone(LESSONS[0].id)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { coverFrameSize, stableStageSize } from './editorStage';

describe('reel editor stage', () => {
  const full = { width: 400, height: 800 };

  it('keeps the full height when the keyboard shrinks the box', () => {
    expect(stableStageSize(full, { width: 400, height: 480 })).toEqual(full);
  });

  it('grows with the box when the keyboard closes again or the first measure was short', () => {
    expect(stableStageSize({ width: 400, height: 480 }, full)).toEqual(full);
  });

  it('takes a new width whole (rotation) and ignores an empty measure', () => {
    expect(stableStageSize(full, { width: 800, height: 400 })).toEqual({ width: 800, height: 400 });
    expect(stableStageSize(full, { width: 0, height: 0 })).toEqual(full);
  });

  it('covers the stage: a narrower media is scaled to the width, a wider one to the height', () => {
    expect(coverFrameSize(full, 9 / 16)).toEqual({ width: 450, height: 800 });
    expect(coverFrameSize(full, 1 / 4)).toEqual({ width: 400, height: 1600 });
    expect(coverFrameSize(full, 1)).toEqual({ width: 800, height: 800 });
  });

  it('answers nothing before the stage is measured', () => {
    expect(coverFrameSize({ width: 0, height: 0 }, 0.5)).toEqual({ width: 0, height: 0 });
  });
});

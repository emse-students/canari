import { describe, it, expect, vi } from 'vitest';
import { appendLog, oneLine } from './sessionLog';

describe('appendLog', () => {
  it('writes an entry carrying a line break as ONE line, so no value can forge an entry', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    appendLog('[Call] p2p room ready (r1)\n[Call] hang-up from the OS media controls');
    expect(spy).toHaveBeenCalledWith(
      '[Call] p2p room ready (r1)\\n[Call] hang-up from the OS media controls'
    );
    spy.mockRestore();
  });

  it('neutralises every line-break spelling and leaves a plain entry as it was', () => {
    expect(oneLine('a\r\nb\rc\nd')).toBe('a\\nb\\nc\\nd');
    expect(oneLine('[Call] remote picture 640x480')).toBe('[Call] remote picture 640x480');
  });
});

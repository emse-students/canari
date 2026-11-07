import { createReadMarkDebounce } from './readMarkDebounce';

/**
 * The read mark of an open conversation, at the LEADING EDGE of a throttle window (owner,
 * 2026-11-07). The window decides only how often: every case asserts the ORDER of deliveries on a
 * fake clock, and the leave case is the defect it replaced - the mark was zeroed on leave after the
 * local mark had moved, so no frame ever announced it.
 */
describe('createReadMarkDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers the first mark of a reading at once, before any timer runs', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(100, deliver, 'A');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(100);
    expect(debounce.pending).toBe(0);
    // Nothing more was noted: the window ends with no second delivery.
    vi.advanceTimersByTime(10000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst inside the window into ONE trailing delivery, the highest mark', () => {
    const debounce = createReadMarkDebounce(2000);
    const delivered: number[] = [];
    const deliver = (at: number) => delivered.push(at);
    debounce.note(100, deliver, 'A');
    debounce.note(300, deliver, 'A');
    debounce.note(200, deliver, 'A');
    expect(delivered).toEqual([100]);
    expect(debounce.pending).toBe(300);
    vi.advanceTimersByTime(2000);
    expect(delivered).toEqual([100, 300]);
    expect(debounce.pending).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(delivered).toEqual([100, 300]);
  });

  it('opens a fresh leading edge once a quiet window has ended', () => {
    const debounce = createReadMarkDebounce(2000);
    const delivered: number[] = [];
    const deliver = (at: number) => delivered.push(at);
    debounce.note(100, deliver, 'A');
    vi.advanceTimersByTime(2000);
    debounce.note(200, deliver, 'A');
    expect(delivered).toEqual([100, 200]);
  });

  it('delivers the trailing mark at once when the reader leaves inside the window', () => {
    const debounce = createReadMarkDebounce(2000);
    const delivered: number[] = [];
    const deliver = (at: number) => delivered.push(at);
    debounce.note(100, deliver, 'A');
    debounce.note(500, deliver, 'A');
    debounce.flush();
    expect(delivered).toEqual([100, 500]);
    // And never twice: the window it ended does not fire again.
    vi.advanceTimersByTime(5000);
    expect(delivered).toEqual([100, 500]);
    expect(debounce.pending).toBe(0);
  });

  it('delivers nothing on leave when nothing is pending', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(500, deliver, 'A');
    debounce.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('keeps the window to the reading that opened it - a later note does not swap its delivery', () => {
    const debounce = createReadMarkDebounce(2000);
    const first = vi.fn();
    const second = vi.fn();
    debounce.note(100, first, 'A');
    debounce.note(200, second, 'A');
    vi.advanceTimersByTime(2000);
    expect(first).toHaveBeenNthCalledWith(1, 100);
    expect(first).toHaveBeenNthCalledWith(2, 200);
    expect(second).not.toHaveBeenCalled();
  });

  it("delivers a salon's trailing mark AND its banner signal through its own callback when the reader leaves inside the window", () => {
    // The salon callback in MainChatPage delivers the owed queue and, under A's own id, the
    // `markChannelRead` that clears A's banner on the account's other devices. Dropping the window
    // on leave (the 2026-10-27 draft's `cancel`) lost that signal.
    const debounce = createReadMarkDebounce(2000);
    const signalled: string[] = [];
    const deliver = (at: number) => signalled.push(`A read to ${at}`);
    debounce.note(100, deliver, 'A');
    debounce.note(150, deliver, 'A');
    debounce.follow('B');
    expect(signalled).toEqual(['A read to 100', 'A read to 150']);
    vi.advanceTimersByTime(5000);
    expect(signalled).toHaveLength(2);
  });

  it('opens the next conversation on a leading edge of its own, even with the old window quiet', () => {
    const debounce = createReadMarkDebounce(2000);
    const delivered: string[] = [];
    debounce.note(100, (at) => delivered.push(`A@${at}`), 'A');
    debounce.follow('B');
    debounce.note(200, (at) => delivered.push(`B@${at}`), 'B');
    expect(delivered).toEqual(['A@100', 'B@200']);
    vi.advanceTimersByTime(5000);
    expect(delivered).toEqual(['A@100', 'B@200']);
  });

  it('keeps the window while the selection stays on its conversation, and does nothing with none armed', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.follow('A');
    debounce.note(100, deliver, 'A');
    debounce.note(120, deliver, 'A');
    debounce.follow('A');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(debounce.pending).toBe(120);
    vi.advanceTimersByTime(2000);
    expect(deliver).toHaveBeenLastCalledWith(120);
    // The window is spent: a later leave has nothing to deliver.
    vi.advanceTimersByTime(2000);
    debounce.follow(null);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});

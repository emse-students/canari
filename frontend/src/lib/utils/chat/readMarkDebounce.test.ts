import { createReadMarkDebounce } from './readMarkDebounce';

/**
 * The pending read mark of an open conversation. The window is the one clock and decides only WHEN:
 * every case below asserts what is delivered, and the leave case is the defect it replaced - the
 * mark was zeroed on leave after the local mark had moved, so no frame ever announced it.
 */
describe('createReadMarkDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers one mark per window, the highest noted in it', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(100, deliver, 'A');
    debounce.note(300, deliver, 'A');
    debounce.note(200, deliver, 'A');
    vi.advanceTimersByTime(2000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(300);
  });

  it('delivers the pending mark at once when the reader leaves inside the window', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(500, deliver, 'A');
    debounce.flush();
    expect(deliver).toHaveBeenCalledWith(500);
    // And never twice: the window it ended does not fire again.
    vi.advanceTimersByTime(5000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(debounce.pending).toBe(0);
  });

  it('delivers nothing on leave when nothing is pending', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(500, deliver, 'A');
    vi.advanceTimersByTime(2000);
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
    expect(first).toHaveBeenCalledWith(200);
    expect(second).not.toHaveBeenCalled();
  });

  it("delivers a salon's mark AND its banner signal through its own callback when the reader leaves inside the window", () => {
    // The salon callback in MainChatPage delivers the owed queue and, under A's own id, the
    // `markChannelRead` that clears A's banner on the account's other devices. Dropping the window
    // on leave (the 2026-10-27 draft's `cancel`) lost that signal.
    const debounce = createReadMarkDebounce(2000);
    const signalled: string[] = [];
    debounce.note(100, (at) => signalled.push(`A read to ${at}`), 'A');
    debounce.follow('B');
    expect(signalled).toEqual(['A read to 100']);
    vi.advanceTimersByTime(5000);
    expect(signalled).toHaveLength(1);
  });

  it('opens the next conversation on a window of its own once the leave delivered the old one', () => {
    const debounce = createReadMarkDebounce(2000);
    const delivered: string[] = [];
    debounce.note(100, (at) => delivered.push(`A@${at}`), 'A');
    debounce.follow('B');
    debounce.note(200, (at) => delivered.push(`B@${at}`), 'B');
    vi.advanceTimersByTime(2000);
    expect(delivered).toEqual(['A@100', 'B@200']);
  });

  it('keeps the window while the selection stays on its conversation, and does nothing with none armed', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.follow('A');
    debounce.note(100, deliver, 'A');
    debounce.follow('A');
    expect(deliver).not.toHaveBeenCalled();
    expect(debounce.pending).toBe(100);
    vi.advanceTimersByTime(2000);
    expect(deliver).toHaveBeenCalledWith(100);
    // The window is spent: a later leave has nothing to deliver.
    debounce.follow(null);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

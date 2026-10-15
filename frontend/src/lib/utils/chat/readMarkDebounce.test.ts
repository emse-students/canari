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
    debounce.note(100, deliver);
    debounce.note(300, deliver);
    debounce.note(200, deliver);
    vi.advanceTimersByTime(2000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(300);
  });

  it('delivers the pending mark at once when the reader leaves inside the window', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(500, deliver);
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
    debounce.note(500, deliver);
    vi.advanceTimersByTime(2000);
    debounce.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('keeps the window to the reading that opened it - a later note does not swap its delivery', () => {
    const debounce = createReadMarkDebounce(2000);
    const first = vi.fn();
    const second = vi.fn();
    debounce.note(100, first);
    debounce.note(200, second);
    vi.advanceTimersByTime(2000);
    expect(first).toHaveBeenCalledWith(200);
    expect(second).not.toHaveBeenCalled();
  });

  it('forgets a mark that is owed elsewhere (a salon) without delivering it', () => {
    const debounce = createReadMarkDebounce(2000);
    const deliver = vi.fn();
    debounce.note(100, deliver);
    debounce.cancel();
    vi.advanceTimersByTime(5000);
    expect(deliver).not.toHaveBeenCalled();
  });
});

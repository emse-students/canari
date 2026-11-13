import { beforeEach, describe, expect, it, vi } from 'vitest';

type Lookup = (id: string) => Promise<unknown>;
let lookup: Lookup = async () => ({ linkedEvent: null });
vi.mock('$lib/associations/api', () => ({
  getCalendarEventLinkedToPost: (id: string) => lookup(id),
}));
vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn() } }));

import { fromPostOf, openEventLinkedToPost, postEventHref } from './postEventLink';

function fakeAgenda(scheduleLayout = false) {
  const calls: string[] = [];
  return {
    calls,
    scheduleLayout,
    focusDate: new Date(2026, 0, 1),
    selectedDay: 4 as number | null,
    reload: vi.fn(async () => void calls.push('reload')),
    openDetail: vi.fn(() => void calls.push('open')),
  };
}

const event = { id: 'e1', startsAt: '2026-12-15T19:00:00.000Z' };

describe('postEventLink', () => {
  beforeEach(() => {
    lookup = async () => ({ linkedEvent: null });
  });

  it('the chip leads to the global agenda with the post id, encoded', () => {
    expect(postEventHref('p 1')).toBe('/calendar?fromPost=p%201');
  });

  it('reads fromPost from a URL', () => {
    expect(fromPostOf(new URL('http://x/calendar?fromPost=%20p1 '))).toBe('p1');
    expect(fromPostOf(new URL('http://x/calendar'))).toBe('');
  });

  it('opens the linked event, regardless of filters', async () => {
    lookup = async () => ({ linkedEvent: event });
    const a = fakeAgenda();
    expect(await openEventLinkedToPost(a as never, 'p1')).toBe(true);
    expect(a.openDetail).toHaveBeenCalledWith(event);
    expect(a.reload).not.toHaveBeenCalled();
  });

  it('showItsMonth moves the grid to the event month and reloads BEFORE opening', async () => {
    lookup = async () => ({ linkedEvent: event });
    const a = fakeAgenda();
    await openEventLinkedToPost(a as never, 'p1', { showItsMonth: true });
    expect(a.focusDate.getMonth()).toBe(11);
    expect(a.selectedDay).toBeNull();
    expect(a.calls).toEqual(['reload', 'open']);
  });

  it('leaves the phone rolling window alone', async () => {
    lookup = async () => ({ linkedEvent: event });
    const a = fakeAgenda(true);
    await openEventLinkedToPost(a as never, 'p1', { showItsMonth: true });
    expect(a.calls).toEqual(['open']);
  });

  it('opens nothing when the post links no visible event', async () => {
    lookup = async () => ({ linkedEvent: null });
    const a = fakeAgenda();
    expect(await openEventLinkedToPost(a as never, 'p1')).toBe(false);
    expect(a.openDetail).not.toHaveBeenCalled();
  });

  it('opens nothing when the lookup fails', async () => {
    lookup = async () => {
      throw new Error('403');
    };
    const a = fakeAgenda();
    expect(await openEventLinkedToPost(a as never, 'p1')).toBe(false);
    expect(a.openDetail).not.toHaveBeenCalled();
  });
});

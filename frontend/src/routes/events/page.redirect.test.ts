import { describe, expect, it } from 'vitest';
import { load } from './+page';

describe('/events', () => {
  it('leads to the calendar instead of a static empty state that contradicts it', () => {
    try {
      load();
      expect.unreachable('load() must redirect');
    } catch (e) {
      expect(e).toMatchObject({ status: 302, location: '/calendar' });
    }
  });
});

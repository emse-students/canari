import { describe, expect, it } from 'vitest';
import { announcementStep } from './connectionAnnouncement';

describe('announcementStep', () => {
  it('says offline and reconnecting, and remembers the outage', () => {
    expect(announcementStep(false, 'offline')).toEqual({ outage: true, say: 'offline' });
    expect(announcementStep(false, 'reconnecting')).toEqual({ outage: true, say: 'reconnecting' });
  });

  it('says "back" once after an outage', () => {
    expect(announcementStep(true, 'connected')).toEqual({ outage: false, say: 'back' });
    expect(announcementStep(false, 'connected')).toEqual({ outage: false, say: null });
  });

  it('a slow link that clears is silent, flap after flap', () => {
    let outage = false;
    for (let i = 0; i < 3; i++) {
      expect(announcementStep(outage, 'slow').say).toBe('slow');
      const cleared = announcementStep(outage, 'connected');
      expect(cleared.say).toBeNull();
      outage = cleared.outage;
    }
  });

  it('an outage survives a slow spell and is still announced as back', () => {
    const slow = announcementStep(true, 'slow');
    expect(slow.outage).toBe(true);
    expect(announcementStep(slow.outage, 'connected').say).toBe('back');
  });

  it('a logged-out visitor hears nothing and forgets the outage', () => {
    expect(announcementStep(true, null)).toEqual({ outage: false, say: null });
  });
});

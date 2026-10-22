// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { showInitialsInstead } from './trombinoscope';

describe('a member photo that does not load (trombinoscope export)', () => {
  it('is removed, and the initials box after it is shown', () => {
    // Was an `onerror="..."` attribute, which the Content-Security-Policy refuses (no inline script):
    // the photo stayed a broken image and the initials never appeared. It is a listener now.
    const card = document.createElement('div');
    card.innerHTML =
      '<img src="/missing" data-avatar-fallback /><div style="display:none">AB</div>';
    const img = card.querySelector('img')!;
    const initials = card.querySelector('div')!;

    showInitialsInstead(img);

    expect(card.querySelector('img')).toBeNull();
    expect(initials.style.display).toBe('flex');
  });
});

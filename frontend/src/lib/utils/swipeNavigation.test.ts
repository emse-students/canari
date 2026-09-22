import {
  classifySwipeRelease,
  isSwipeNavArmed,
  isSwipeNavRoute,
  resolveSwipeNavIndex,
  shouldIgnoreSwipeTarget,
  swipeNavTargetHref,
  updateSwipeNavGesture,
} from './swipeNavigation';

describe('isSwipeNavRoute', () => {
  it('allows main mobile tab routes', () => {
    expect(isSwipeNavRoute('/posts')).toBe(true);
    expect(isSwipeNavRoute('/posts/abc')).toBe(true);
    expect(isSwipeNavRoute('/chat')).toBe(true);
  });

  it('blocks association and profile sub-routes', () => {
    expect(isSwipeNavRoute('/associations/foo/edit')).toBe(false);
    expect(isSwipeNavRoute('/profile')).toBe(false);
    expect(isSwipeNavRoute('/forms/create')).toBe(false);
  });
});

describe('isSwipeNavArmed', () => {
  // WHAT THIS PREDICATE DECIDES IS WHETHER A NON-PASSIVE `touchmove` LISTENER EXISTS, which costs
  // its scroller the compositor for as long as it is bound - so a `true` it does not owe is a
  // scroll defect on every screen it reaches, not a spare gesture. Pinned in both directions.
  it('arms only where the route can swipe AND the viewport has a finger', () => {
    expect(isSwipeNavArmed('/posts', true)).toBe(true);
    expect(isSwipeNavArmed('/posts', false)).toBe(false);
  });

  it('stays disarmed on every swipe-excluded prefix, finger or not', () => {
    // The five reported ones. `/associations` is where the horizontal tab strip lives, and the
    // `touch-action` that rode along with this listener is what stopped it panning.
    for (const pathname of ['/associations', '/associations/bde', '/profile', '/forms', '/admin']) {
      expect(isSwipeNavArmed(pathname, true)).toBe(false);
    }
  });

  it('asks nothing about the moment - only about the screen', () => {
    // The fine half (keyboard, open conversation, overlay depth) belongs to `isSwipeNavActive` and
    // is read at gesture time. If it ever leaks in here, the listener set starts following state
    // that changes under the finger, and a gesture loses its `touchend` mid-drag.
    expect(isSwipeNavArmed('/chat', true)).toBe(true);
  });
});

describe('swipeNavTargetHref', () => {
  it('returns adjacent tab href', () => {
    expect(swipeNavTargetHref('/posts', 'next')).toBe('/communities');
    expect(swipeNavTargetHref('/communities', 'prev')).toBe('/posts');
  });

  it('returns null at ends', () => {
    expect(swipeNavTargetHref('/posts', 'prev')).toBeNull();
    expect(swipeNavTargetHref('/dashboard', 'next')).toBeNull();
  });

  it('reaches dashboard directly after chat (notifications moved to header)', () => {
    expect(swipeNavTargetHref('/chat', 'next')).toBe('/dashboard');
    expect(swipeNavTargetHref('/dashboard', 'prev')).toBe('/chat');
  });
});

describe('shouldIgnoreSwipeTarget', () => {
  it('ignores data-swipe-nav-ignore', () => {
    document.body.innerHTML = '<div data-swipe-nav-ignore><button id="t">Tab</button></div>';
    expect(shouldIgnoreSwipeTarget(document.getElementById('t'))).toBe(true);
  });

  it('ignores data-swipe-reply message bubbles', () => {
    document.body.innerHTML = '<div data-swipe-reply><span id="m">Hi</span></div>';
    expect(shouldIgnoreSwipeTarget(document.getElementById('m'))).toBe(true);
  });

  it('does NOT ignore a plain link or button - a feed of card links must stay swipeable', () => {
    // Used to be excluded outright, which left almost nothing in a card-heavy feed able to start
    // the gesture. `classifySwipeRelease` is what actually tells a tap from a drag, by
    // displacement - not this predicate, and not the element's tag.
    document.body.innerHTML =
      '<a id="link" href="/calendar">Agenda</a><button id="btn" type="button">Go</button>';
    expect(shouldIgnoreSwipeTarget(document.getElementById('link'))).toBe(false);
    expect(shouldIgnoreSwipeTarget(document.getElementById('btn'))).toBe(false);
  });

  it('ignores a link or button inside a data-swipe-nav-ignore region (the app headers)', () => {
    document.body.innerHTML =
      '<header data-swipe-nav-ignore><a id="brand" href="/posts">Canari</a>' +
      '<button id="avatar" type="button">Profile</button></header>';
    expect(shouldIgnoreSwipeTarget(document.getElementById('brand'))).toBe(true);
    expect(shouldIgnoreSwipeTarget(document.getElementById('avatar'))).toBe(true);
  });
});

describe('gesture classification', () => {
  it('locks horizontal after dominant move', () => {
    const state = updateSwipeNavGesture(
      { startX: 0, startY: 0, phase: 'pending', dragPx: 0 },
      40,
      2
    );
    expect(state.phase).toBe('horizontal');
    expect(classifySwipeRelease(-80, 2, state.phase)).toBe('next');
  });

  it('treats vertical scroll as non-navigating', () => {
    const state = updateSwipeNavGesture(
      { startX: 0, startY: 0, phase: 'pending', dragPx: 0 },
      4,
      50
    );
    expect(state.phase).toBe('vertical');
    expect(classifySwipeRelease(100, 50, state.phase)).toBeNull();
  });
});

describe('resolveSwipeNavIndex', () => {
  it('maps nested post route to posts index', () => {
    expect(resolveSwipeNavIndex('/posts/x')).toBe(0);
  });
});

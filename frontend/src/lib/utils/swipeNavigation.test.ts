import { describe, expect, it } from 'vitest';
import {
  classifySwipeRelease,
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

describe('swipeNavTargetHref', () => {
  it('returns adjacent tab href', () => {
    expect(swipeNavTargetHref('/posts', 'next')).toBe('/communities');
    expect(swipeNavTargetHref('/communities', 'prev')).toBe('/posts');
  });

  it('returns null at ends', () => {
    expect(swipeNavTargetHref('/posts', 'prev')).toBeNull();
    expect(swipeNavTargetHref('/dashboard', 'next')).toBeNull();
  });

  it('reaches dashboard after notifications', () => {
    expect(swipeNavTargetHref('/notifications', 'next')).toBe('/dashboard');
    expect(swipeNavTargetHref('/notifications', 'prev')).toBe('/chat');
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

  it('ignores in-app links and buttons', () => {
    document.body.innerHTML =
      '<a id="link" href="/calendar">Agenda</a><button id="btn" type="button">Go</button>';
    expect(shouldIgnoreSwipeTarget(document.getElementById('link'))).toBe(true);
    expect(shouldIgnoreSwipeTarget(document.getElementById('btn'))).toBe(true);
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

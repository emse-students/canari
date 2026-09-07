import { readerCanSeeArrival, isChatRoute, type ArrivalContext } from './arrivalVisibility';

/**
 * THE WHOLE MATRIX, because the defect this predicate exists for was one cell of it.
 *
 * A phone inside conversation A, a message landing in B: the reader hears a tone and can see
 * nothing, the unread badge being in a list the narrow layout does not render. Every row below is
 * an assertion about which signal is owed, and the wide/narrow pairs are what make the layout part
 * of the answer instead of an assumption.
 */
const base: ArrivalContext = {
  conversationKey: 'convo-b',
  selectedConversationKey: 'convo-a',
  pathname: '/chat',
  appOnScreen: true,
  narrowLayout: false,
};
const ctx = (over: Partial<ArrivalContext>): ArrivalContext => ({ ...base, ...over });

describe('readerCanSeeArrival', () => {
  it('the app being off screen settles it, whatever else is true', () => {
    expect(readerCanSeeArrival(ctx({ appOnScreen: false }))).toBe(false);
    // Even for the conversation that IS open - a backgrounded app shows nobody anything.
    expect(
      readerCanSeeArrival(ctx({ appOnScreen: false, selectedConversationKey: 'convo-b' }))
    ).toBe(false);
  });

  it('the conversation itself being open is visible at every width', () => {
    expect(readerCanSeeArrival(ctx({ selectedConversationKey: 'convo-b' }))).toBe(true);
    expect(
      readerCanSeeArrival(ctx({ selectedConversationKey: 'convo-b', narrowLayout: true }))
    ).toBe(true);
    // And off the chat route entirely, which a deep-linked conversation can be.
    expect(
      readerCanSeeArrival(ctx({ selectedConversationKey: 'convo-b', pathname: '/posts' }))
    ).toBe(true);
  });

  it('THE DEFECT: narrow, another conversation open - nothing is visible', () => {
    expect(readerCanSeeArrival(ctx({ narrowLayout: true }))).toBe(false);
  });

  it('wide keeps the list beside the conversation, so the row lighting up is visible', () => {
    expect(readerCanSeeArrival(ctx({ narrowLayout: false }))).toBe(true);
  });

  it('narrow with no conversation open shows the list, so it is visible', () => {
    expect(readerCanSeeArrival(ctx({ narrowLayout: true, selectedConversationKey: '' }))).toBe(
      true
    );
    expect(readerCanSeeArrival(ctx({ narrowLayout: true, selectedConversationKey: null }))).toBe(
      true
    );
  });

  it('off the chat route the list does not exist, so an unopened conversation is invisible', () => {
    expect(readerCanSeeArrival(ctx({ pathname: '/posts' }))).toBe(false);
    expect(readerCanSeeArrival(ctx({ pathname: '/posts', narrowLayout: true }))).toBe(false);
    // A wide window elsewhere in the app is still elsewhere: no list, nothing to see.
    expect(readerCanSeeArrival(ctx({ pathname: '/calendar', narrowLayout: false }))).toBe(false);
  });

  it('an empty selection never matches an empty conversation key', () => {
    // Guards the comparison itself: `'' === ''` would call every arrival visible off-route.
    expect(
      readerCanSeeArrival(
        ctx({ conversationKey: '', selectedConversationKey: '', pathname: '/posts' })
      )
    ).toBe(false);
  });
});

describe('isChatRoute', () => {
  it('accepts the chat route and its children', () => {
    expect(isChatRoute('/chat')).toBe(true);
    expect(isChatRoute('/chat/abc')).toBe(true);
  });

  it('rejects a route that merely starts with the same letters', () => {
    // `startsWith('/chat')` alone would have accepted this one.
    expect(isChatRoute('/chatter')).toBe(false);
    expect(isChatRoute('/')).toBe(false);
    expect(isChatRoute('/posts')).toBe(false);
  });
});

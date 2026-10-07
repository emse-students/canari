import { socialDeepLink } from './push-target';

describe('socialDeepLink - the payload contract of a tap', () => {
  it('a post notice opens the post', () => {
    expect(socialDeepLink({ type: 'social', postId: 'p1' })).toBe('fr.emse.canari://post/p1');
  });

  it('a form reminder opens the form', () => {
    expect(socialDeepLink({ type: 'form_reminder', formId: 'f1' })).toBe(
      'fr.emse.canari://form/f1'
    );
  });

  it('an event proposal opens the validation queue, the other agenda notices the calendar', () => {
    const base = { type: 'social', associationId: 'a1' };
    expect(socialDeepLink({ ...base, action: 'proposed' })).toBe('fr.emse.canari://admin-agenda');
    for (const action of ['validated', 'rejected', 'updated', 'deleted', 'pending']) {
      expect(socialDeepLink({ ...base, action })).toBe('fr.emse.canari://calendar');
    }
  });

  it('a payload naming nothing opens the posts list', () => {
    expect(socialDeepLink({ type: 'social' })).toBe('fr.emse.canari://posts');
  });

  it('never lets an id carry a path or a query', () => {
    expect(socialDeepLink({ postId: 'a/../b?x=1' })).toBe(
      'fr.emse.canari://post/a%2F..%2Fb%3Fx%3D1'
    );
  });
});

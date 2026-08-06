import { resolveConversationListPresentation } from './conversations';

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PEER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('resolveConversationListPresentation', () => {
  it('keeps direct type when conv.name is only the peer UUID', () => {
    const pres = resolveConversationListPresentation(
      {
        id: GROUP,
        name: PEER,
        contactName: PEER,
        conversationType: 'direct',
        directPeerId: PEER,
        metaName: `${ME}::${PEER}`,
      },
      ME
    );
    expect(pres.conversationType).toBe('direct');
    expect(pres.contactId).toBe(PEER);
    expect(pres.displayName).not.toContain('::');
  });

  it('does not surface canonical direct keys as display names', () => {
    const pres = resolveConversationListPresentation(
      {
        id: GROUP,
        name: `${ME}::${PEER}`,
        contactName: PEER,
        conversationType: 'direct',
        directPeerId: PEER,
      },
      ME
    );
    expect(pres.conversationType).toBe('direct');
    expect(pres.contactId).toBe(PEER);
    expect(pres.displayName).not.toContain('::');
  });

  it('reports an unresolved display name as a placeholder, not as a name', () => {
    // The peer's profile has never been fetched, so nothing can be known synchronously. Returning
    // a label with no way to tell it apart from a real name is what made the whole DM list read
    // "Utilisateur inconnu" after any client-side navigation: the placeholder is non-empty, so the
    // tile preferred it over the name it had itself resolved asynchronously.
    const pres = resolveConversationListPresentation(
      {
        id: GROUP,
        name: `${ME}::${PEER}`,
        contactName: PEER,
        conversationType: 'direct',
        directPeerId: PEER,
      },
      ME
    );
    expect(pres.displayNameResolved).toBe(false);
    expect(pres.displayName).toBeTruthy();
  });

  it('reports a previously resolved label as resolved', () => {
    // `fallbackDisplayName` is a name this row already carried, so it is an answer rather than a
    // placeholder even though the module cache is cold in this process.
    const pres = resolveConversationListPresentation(
      {
        id: GROUP,
        name: `${ME}::${PEER}`,
        contactName: PEER,
        conversationType: 'direct',
        directPeerId: PEER,
        fallbackDisplayName: 'Claire VAN RUYMBEKE',
      },
      ME
    );
    expect(pres.displayNameResolved).toBe(true);
    expect(pres.displayName).toBe('Claire VAN RUYMBEKE');
  });

  it('treats a group name as resolved', () => {
    const pres = resolveConversationListPresentation(
      { id: GROUP, name: 'Bureau des eleves', contactName: GROUP, conversationType: 'group' },
      ME
    );
    expect(pres.displayNameResolved).toBe(true);
  });

  it('does not throw when direct metadata is incomplete during reload', () => {
    const pres = resolveConversationListPresentation(
      {
        id: GROUP,
        name: '',
        contactName: '',
        conversationType: 'direct',
      },
      ME
    );
    expect(pres.conversationType).toBe('group');
    expect(pres.contactId).toBe(GROUP);
  });
});

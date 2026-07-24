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

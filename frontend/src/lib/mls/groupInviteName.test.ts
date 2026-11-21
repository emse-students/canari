import { describe, expect, it } from 'vitest';
import {
  fragmentOf,
  inviteCardName,
  inviteLinkName,
  readInviteNameFragment,
  withInviteNameFragment,
} from './groupInviteName';

describe('inviteLinkName - only the members dated name is handed out', () => {
  it('carries a group name a frame dated', () => {
    expect(inviteLinkName({ name: ' Bureau ', nameAt: 1, conversationType: 'group' })).toBe(
      'Bureau'
    );
  });

  it('carries nothing for an undated row, which may hold a placeholder', () => {
    expect(inviteLinkName({ name: 'Bureau', conversationType: 'group' })).toBeNull();
  });

  it('carries nothing for an empty name, a DM, a channel or no row', () => {
    expect(inviteLinkName({ name: '  ', nameAt: 1, conversationType: 'group' })).toBeNull();
    expect(inviteLinkName({ name: 'x', nameAt: 1, conversationType: 'direct' })).toBeNull();
    expect(inviteLinkName({ name: 'x', nameAt: 1, conversationType: 'channel' })).toBeNull();
    expect(inviteLinkName(null)).toBeNull();
  });
});

describe('the fragment round-trips any name', () => {
  it.each(['Bureau des arts', 'A+B & C', '#100%', 'Été 🎉 / promo?', 'name=x#y'])('%s', (name) => {
    const url = withInviteNameFragment('https://canari.emse.fr/g/join/tok', name);
    expect(url.startsWith('https://canari.emse.fr/g/join/tok#')).toBe(true);
    // The path and the query are untouched: nothing of the name is in what a request carries.
    const u = new URL(url);
    expect(u.pathname).toBe('/g/join/tok');
    expect(u.search).toBe('');
    expect(readInviteNameFragment(u.hash)).toEqual({ name });
  });

  it('a link with no name carries no fragment', () => {
    expect(withInviteNameFragment('https://x/g/join/tok', null)).toBe('https://x/g/join/tok');
  });
});

describe('readInviteNameFragment', () => {
  it('reads absence, with or without the hash sign', () => {
    expect(readInviteNameFragment('')).toEqual({ absent: 'no-fragment' });
    expect(readInviteNameFragment('#')).toEqual({ absent: 'no-fragment' });
    expect(readInviteNameFragment('#other=1')).toEqual({ absent: 'no-fragment' });
    expect(readInviteNameFragment('name=Bureau')).toEqual({ name: 'Bureau' });
  });

  it('reads a blank name as empty', () => {
    expect(readInviteNameFragment('#name=+++')).toEqual({ absent: 'empty' });
  });

  it('never throws on a malformed escape', () => {
    expect(() => readInviteNameFragment('#name=%E0%A4%A')).not.toThrow();
  });
});

describe('inviteCardName', () => {
  it('the fragment wins over the server name', () => {
    expect(inviteCardName({ name: 'Frag' }, 'Server')).toBe('Frag');
  });

  it('a link with no fragment reads the server name (legacy)', () => {
    expect(inviteCardName({ absent: 'no-fragment' }, ' Server ')).toBe('Server');
    expect(inviteCardName({ absent: 'no-fragment' }, null)).toBeNull();
    expect(inviteCardName({ absent: 'empty' }, '  ')).toBeNull();
  });
});

describe('fragmentOf', () => {
  it('reads the fragment of an absolute URL and of a path', () => {
    expect(fragmentOf('https://x/g/join/t#name=A')).toBe('#name=A');
    expect(fragmentOf('/g/join/t#name=A')).toBe('#name=A');
    expect(fragmentOf('/g/join/t')).toBe('');
  });
});

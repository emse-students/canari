import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { summarizeWriterRoles, writePolicyLine } from './channelWritePolicy';

const ADMIN = { id: 'r-admin', name: 'Administrateur', displayLabel: null };
const MODERATOR = { id: 'r-mod', name: 'Modérateur', displayLabel: null };
const BUREAU = { id: 'r-bureau', name: 'Modérateur', displayLabel: 'Bureau' };

describe('writePolicyLine', () => {
  it('says who may write, by the policy', () => {
    expect(writePolicyLine('admins')).toBe(m.chat_channel_write_only_admins());
    expect(writePolicyLine('admins_moderators')).toBe(m.chat_channel_write_only_admins_mods());
  });

  it('falls back to the generic line when the row does not know its policy', () => {
    expect(writePolicyLine(undefined)).toBe(m.chat_channel_read_only());
  });
});

/**
 * WHAT THE ACCESS PANEL SAYS UNDER ITS SELECT. The lists come from the server, which qualified each
 * role by what it grants; this only names them and spots the one case worth a warning.
 */
describe('summarizeWriterRoles', () => {
  it('names nothing for the open policy', () => {
    expect(summarizeWriterRoles('everyone', { admins: [ADMIN], admins_moderators: [ADMIN] })).toBe(
      null
    );
  });

  it('names nothing when the server sent no list (an older server)', () => {
    expect(summarizeWriterRoles('admins_moderators', undefined)).toBe(null);
  });

  it('names the qualifying roles by their community label', () => {
    expect(
      summarizeWriterRoles('admins_moderators', {
        admins: [ADMIN],
        admins_moderators: [ADMIN, BUREAU],
      })
    ).toEqual({ names: [m.chat_role_admin(), 'Bureau'], onlyAdmins: false });
  });

  it('warns when "admins and moderators" admits the admins alone', () => {
    // The production case: the moderator role exists and grants nothing, so the server left it out.
    expect(
      summarizeWriterRoles('admins_moderators', { admins: [ADMIN], admins_moderators: [ADMIN] })
    ).toEqual({ names: [m.chat_role_admin()], onlyAdmins: true });
  });

  it('never warns under admins-only, where the admins alone is the point', () => {
    expect(
      summarizeWriterRoles('admins', { admins: [ADMIN], admins_moderators: [ADMIN, MODERATOR] })
    ).toEqual({ names: [m.chat_role_admin()], onlyAdmins: false });
  });
});

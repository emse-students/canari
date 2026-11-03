import { Logger } from '@nestjs/common';
import {
  ALL_CORE_FLAGS,
  AssociationPermissionFlag as F,
} from './entities/association-member.entity';
import { LEGACY_ADMIN_PRESETS, withLegacyEditProfile } from './legacy-admin-presets';

/**
 * An admin added from a build older than EDIT_PROFILE (store builds up to 1.6.2) is posted one of
 * that build's presets, none of which carries bit 12. The pinned numbers below are what those
 * builds really sent (their `ASSOCIATION_ADMIN_PRESET`, `ALL_CORE_FLAGS`, and the per-kind
 * `adminPresetFor` of a list or an institution); the module derives them, this test reads them.
 */
describe('legacy admin presets (shim until 2027-05-03)', () => {
  const logger = new Logger('test');

  it('is exactly the presets the old builds posted', () => {
    expect([...LEGACY_ADMIN_PRESETS].sort((a, b) => a - b)).toEqual([3103, 3359, 3871]);
  });

  it("carries no EDIT_PROFILE, and is today's presets with bit 12 taken out", () => {
    for (const mask of LEGACY_ADMIN_PRESETS) expect(mask & F.EDIT_PROFILE).toBe(0);
    expect(LEGACY_ADMIN_PRESETS.has(ALL_CORE_FLAGS & ~F.EDIT_PROFILE)).toBe(true);
  });

  it('adds EDIT_PROFILE to an exact old preset, and logs the legacy match', () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    for (const mask of LEGACY_ADMIN_PRESETS) {
      expect(withLegacyEditProfile(logger, mask, 'addMember')).toBe(mask | F.EDIT_PROFILE);
    }
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[LEGACY] addMember'));
  });

  it('leaves every other mask alone: a near-preset, a plain member, a current preset', () => {
    for (const mask of [0, 3871 & ~F.MANAGE_FORMS, 3871 | F.EDIT_PROFILE, F.MANAGE_MEMBERS]) {
      expect(withLegacyEditProfile(logger, mask, 'updateMemberRole')).toBe(mask);
    }
  });
});

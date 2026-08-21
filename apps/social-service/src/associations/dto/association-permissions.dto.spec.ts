import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddMemberDto, UpdateMemberRoleDto } from './association.dto';
import {
  ALL_CORE_FLAGS,
  ALL_PERMISSION_FLAGS,
  AssociationPermissionFlag,
} from '../entities/association-member.entity';

/** The admin preset the frontend sends for the "Admin" role option (core flags + Stripe Connect). */
const ASSOCIATION_ADMIN_PRESET = ALL_CORE_FLAGS | AssociationPermissionFlag.MANAGE_STRIPE_CONNECT;

/** Collects the failing property names, so an assertion says WHICH constraint rejected. */
const failedProps = (dto: object): string[] => validateSync(dto).map((error) => error.property);

const addMember = (permissions: number): AddMemberDto =>
  plainToInstance(AddMemberDto, { userId: 'u1', role: 'Admin', permissions });

const updateRole = (permissions: number): UpdateMemberRoleDto =>
  plainToInstance(UpdateMemberRoleDto, { role: 'Admin', permissions });

describe('association member permission bounds', () => {
  describe('ALL_PERMISSION_FLAGS', () => {
    it('covers every flag the enum defines', () => {
      const flags = Object.values(AssociationPermissionFlag).filter(
        (value): value is AssociationPermissionFlag => typeof value === 'number'
      );

      expect(flags).not.toHaveLength(0);
      for (const flag of flags) {
        expect(ALL_PERMISSION_FLAGS & flag).toBe(flag);
      }
    });

    it('is contiguous from bit 0 - a gap means a flag was renumbered', () => {
      const flagCount = Object.values(AssociationPermissionFlag).filter(
        (value) => typeof value === 'number'
      ).length;

      expect(ALL_PERMISSION_FLAGS).toBe(2 ** flagCount - 1);
    });
  });

  // Regression: MANAGE_PARTNERSHIPS (bit 10) pushed both presets past a hardcoded @Max(1023),
  // so the "Admin" role option 400-ed on every association. See CHANGELOG.
  describe.each([
    ['AddMemberDto', addMember],
    ['UpdateMemberRoleDto', updateRole],
  ])('%s.permissions', (_name, build) => {
    it('accepts the admin preset the frontend actually sends', () => {
      expect(failedProps(build(ASSOCIATION_ADMIN_PRESET))).toEqual([]);
    });

    it('accepts every single flag on its own, including the newest bit', () => {
      const flags = Object.values(AssociationPermissionFlag).filter(
        (value): value is AssociationPermissionFlag => typeof value === 'number'
      );

      for (const flag of flags) {
        expect(failedProps(build(flag))).toEqual([]);
      }
    });

    it('accepts the bounds - 0 (simple member) and every flag at once', () => {
      expect(failedProps(build(0))).toEqual([]);
      expect(failedProps(build(ALL_PERMISSION_FLAGS))).toEqual([]);
    });

    it('still rejects a mask carrying an undefined bit, and a negative one', () => {
      expect(failedProps(build(ALL_PERMISSION_FLAGS + 1))).toEqual(['permissions']);
      expect(failedProps(build(-1))).toEqual(['permissions']);
    });
  });

  it('leaves UpdateMemberRoleDto.permissions optional', () => {
    expect(failedProps(plainToInstance(UpdateMemberRoleDto, { role: 'Membre' }))).toEqual([]);
  });
});

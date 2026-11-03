import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssociationPermissionFlag as F } from '$lib/associations/api';
import {
  PLATFORM_ADMIN_ONLY,
  PROFILE_FORM_FIELDS,
  UPDATE_FIELD_RIGHTS,
  mayWriteFields,
} from './updateFields';

// Kept in a variable: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL.
const SERVER_REL = '../../../../apps/social-service/src/associations/association-update-rights.ts';

const none = { isGlobalAdmin: false, isSuperAdmin: false, memberPermissions: 0 };
const holding = (mask: number) => ({ ...none, memberPermissions: mask });

describe('the PATCH :id field table', () => {
  /**
   * ONE table, two copies: the server decides with its own, the screens draw from this one. Reading
   * the server file makes a drift (a field moved on one side only) a failing test, not a control
   * that is offered and then refused.
   */
  it('is the server table, field for field', () => {
    const source = readFileSync(fileURLToPath(new URL(SERVER_REL, import.meta.url)), 'utf8');
    const body = source.slice(source.indexOf('export const UPDATE_FIELD_RIGHTS'));
    const table = body.slice(0, body.indexOf('};'));
    const server: Record<string, string> = {};
    for (const [, field, right] of table.matchAll(
      /^\s+(\w+): (?:AssociationPermissionFlag\.(\w+)|PLATFORM_ADMIN_ONLY),$/gm
    )) {
      server[field] = right ?? PLATFORM_ADMIN_ONLY;
    }
    const client = Object.fromEntries(
      Object.entries(UPDATE_FIELD_RIGHTS).map(([field, right]) => [
        field,
        right === PLATFORM_ADMIN_ONLY ? right : F[right],
      ])
    );
    expect(Object.keys(server)).not.toHaveLength(0);
    expect(client).toEqual(server);
  });

  it('opens the profile form on EDIT_PROFILE alone, and never on MANAGE_MEMBERS', () => {
    expect(mayWriteFields(PROFILE_FORM_FIELDS, holding(F.EDIT_PROFILE))).toBe(true);
    expect(mayWriteFields(PROFILE_FORM_FIELDS, holding(F.MANAGE_MEMBERS))).toBe(false);
  });

  it('never puts a platform-admin field in the profile form', () => {
    for (const field of PROFILE_FORM_FIELDS) {
      expect(UPDATE_FIELD_RIGHTS[field], field).not.toBe(PLATFORM_ADMIN_ONLY);
    }
  });

  it('gives the cotisation settings to MANAGE_PRODUCTS alone', () => {
    const fields = ['cotisationEnabled', 'cotisationMode'] as const;
    expect(mayWriteFields(fields, holding(F.MANAGE_PRODUCTS))).toBe(true);
    expect(mayWriteFields(fields, holding(F.MANAGE_MEMBERS | F.EDIT_PROFILE))).toBe(false);
  });

  it('keeps the quota and the parent to the platform administrator, whatever the flags', () => {
    const fields = ['documentQuotaBytes', 'parentAssociationId'] as const;
    expect(mayWriteFields(fields, holding(8191))).toBe(false);
    expect(mayWriteFields(fields, { ...none, isSuperAdmin: true })).toBe(false);
    expect(mayWriteFields(fields, { ...none, isGlobalAdmin: true })).toBe(true);
  });

  it('ignores a bit this client does not know: an unknown bit grants nothing and blocks nothing', () => {
    const unknown = 1 << 20;
    expect(mayWriteFields(PROFILE_FORM_FIELDS, holding(unknown))).toBe(false);
    expect(mayWriteFields(PROFILE_FORM_FIELDS, holding(unknown | F.EDIT_PROFILE))).toBe(true);
  });
});

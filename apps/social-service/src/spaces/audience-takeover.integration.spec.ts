/**
 * ONE CAMPUS, TWO BDEs: A BDE CANNOT TAKE OVER THE OTHER'S ASSOCIATION, against a REAL PostgreSQL.
 *
 * Governance is per SPACE (`holdsBdeFlagOverSql`); the audience bound used to be per CAMPUS. So an
 * officer of the BDE governing (ICM, saint-etienne) could rewrite the audience of an association
 * reaching only (ISMIN, saint-etienne) - governed by another BDE - into its own space, become its
 * super-admin, then seat itself there. This file runs the real standing SQL
 * (`BDE_SPACE_STANDINGS_SQL`) and the real governance SQL (`HOLDS_BDE_FLAG_OVER_SQL`) and feeds them
 * to the policies that decide (`assertBdeMayWriteAudience`, `grantCeiling`).
 *
 * GATED ON `SOCIAL_IT_DATABASE_URL`, like `bde.integration.spec.ts`; CI's `test-social-integration`
 * sets it. Locally:
 *
 *   SOCIAL_IT_DATABASE_URL=postgres://user:pass@localhost:5432/scratch bun run test -- audience-takeover.integration
 *
 * Everything happens in a throwaway schema, dropped at the end.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ForbiddenException, HttpException, Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AssociationsService } from '../associations/associations.service';
import { GlobalAdminOrAssociationRoleGuard } from '../associations/guards/global-admin-or-association-role.guard';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { flagsBeyondCeiling, grantCeiling } from '../associations/member-flag-ceiling';
import { assertBdeMayWriteAudience, type SpaceStanding } from './audience-policy';
import { BDE_SPACE_STANDINGS_SQL, HOLDS_BDE_FLAG_OVER_SQL } from './bde';

const URL = process.env.SOCIAL_IT_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

const migration = (name: string) => readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');

const { MANAGE_ASSO, MANAGE_MEMBERS, POST_AS_ASSO, VALIDATE_EVENTS } = AssociationPermissionFlag;

const A = {
  bdeIcm: '00000000-0000-4000-8000-0000000000d1', // BDE of (ICM, saint-etienne)
  bdeIsmin: '00000000-0000-4000-8000-0000000000d2', // BDE of every OTHER saint-etienne space
  clubIcm: '00000000-0000-4000-8000-0000000000e1', // reaches (ICM, saint-etienne) only
  clubIsmin: '00000000-0000-4000-8000-0000000000e2', // reaches (ISMIN, saint-etienne) only
  school: '00000000-0000-4000-8000-0000000000e3', // an INSTITUTION reaching (ICM, saint-etienne)
  schoolIsmin: '00000000-0000-4000-8000-0000000000e4', // an INSTITUTION reaching (ISMIN, s-e) only
} as const;

/** The refusal's typed code, or null when the call passed. */
const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return (e.getResponse() as { code: string }).code;
  }
};

maybe('one campus with two BDEs, against PostgreSQL', () => {
  const schema = `takeover_it_${Math.random().toString(36).slice(2, 10)}`;
  let client: Client;

  const standings = async (userId: string): Promise<SpaceStanding[]> =>
    (await client.query(BDE_SPACE_STANDINGS_SQL, [userId, MANAGE_ASSO])).rows as SpaceStanding[];
  const rulesOf = async (id: string) =>
    (
      await client.query(
        `SELECT formation, campus FROM association_audiences WHERE "associationId" = $1`,
        [id]
      )
    ).rows as { formation: string | null; campus: string | null }[];
  const governs = async (userId: string, id: string): Promise<boolean> =>
    (await client.query(HOLDS_BDE_FLAG_OVER_SQL, [userId, id, MANAGE_ASSO])).rows[0].holds === true;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE associations (id uuid PRIMARY KEY, name varchar NOT NULL,
        "isBDE" boolean NOT NULL DEFAULT false, type varchar NOT NULL DEFAULT 'association');
      CREATE TABLE posts (id uuid PRIMARY KEY);
      CREATE TABLE association_members (id serial PRIMARY KEY, "associationId" uuid NOT NULL,
        "userId" varchar(255) NOT NULL, permissions integer NOT NULL DEFAULT 0);
    `);
    for (const [key, id] of Object.entries(A)) {
      await client.query(`INSERT INTO associations (id, name, type) VALUES ($1, $2, $3)`, [
        id,
        key,
        key.startsWith('school') ? 'institution' : 'association',
      ]);
    }
    await client.query(migration('071_spaces.sql'));
    await client.query(migration('072_drop_is_bde.sql'));
    await client.query(`DELETE FROM association_audiences`);
    const rules: [string, string, string][] = [
      [A.bdeIcm, 'ICM', 'saint-etienne'],
      [A.bdeIsmin, 'ISMIN', 'saint-etienne'],
      [A.clubIcm, 'ICM', 'saint-etienne'],
      [A.clubIsmin, 'ISMIN', 'saint-etienne'],
      [A.school, 'ICM', 'saint-etienne'],
      [A.schoolIsmin, 'ISMIN', 'saint-etienne'],
    ];
    for (const [id, formation, campus] of rules) {
      await client.query(
        `INSERT INTO association_audiences ("associationId", formation, campus) VALUES ($1, $2, $3)`,
        [id, formation, campus]
      );
    }
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'saint-etienne' AND formation = 'ICM'`,
      [A.bdeIcm]
    );
    await client.query(
      `UPDATE spaces SET "bdeAssociationId" = $1 WHERE campus = 'saint-etienne' AND formation <> 'ICM'`,
      [A.bdeIsmin]
    );
    await client.query(
      `INSERT INTO association_members ("associationId", "userId", permissions) VALUES
        ($1, 'icmOfficer', $3), ($2, 'isminOfficer', $3)`,
      [A.bdeIcm, A.bdeIsmin, MANAGE_ASSO | MANAGE_MEMBERS | VALIDATE_EVENTS]
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });

  it('the ICM BDE does not govern the ISMIN club, so it seats nobody there with any flag', async () => {
    expect(await governs('icmOfficer', A.clubIsmin)).toBe(false);
    expect(await governs('isminOfficer', A.clubIsmin)).toBe(true);
    // Not a member of the club either: its ceiling there is empty, so a self-grant is beyond it.
    const ceiling = grantCeiling({
      isGlobalAdmin: false,
      isSuperAdminOf: await governs('icmOfficer', A.clubIsmin),
      ownPermissions: 0,
    });
    expect(flagsBeyondCeiling(ceiling, 0, POST_AS_ASSO)).toBe(POST_AS_ASSO);
  });

  it("refuses the takeover: the ICM BDE rewriting the ISMIN club's audience into its own space", async () => {
    const spaces = await standings('icmOfficer');
    const current = await rulesOf(A.clubIsmin);
    expect(
      codeOf(() =>
        assertBdeMayWriteAudience('association', spaces, current, [
          { formation: 'ICM', campus: 'saint-etienne' },
        ])
      )
    ).toBe('AUDIENCE_OUTSIDE_BDE_CAMPUS');
  });

  it('refuses a whole-campus rule to a BDE that governs only part of the campus', async () => {
    const spaces = await standings('icmOfficer');
    const current = await rulesOf(A.clubIcm);
    expect(
      codeOf(() =>
        assertBdeMayWriteAudience('association', spaces, current, [
          { formation: null, campus: 'saint-etienne' },
        ])
      )
    ).toBe('AUDIENCE_OUTSIDE_BDE_CAMPUS');
  });

  it('lets a BDE edit its own association within its spaces', async () => {
    const spaces = await standings('icmOfficer');
    const current = await rulesOf(A.clubIcm);
    expect(
      codeOf(() =>
        assertBdeMayWriteAudience('association', spaces, current, [
          { formation: 'ICM', campus: 'saint-etienne' },
        ])
      )
    ).toBeNull();
    // ... and not push it into the other BDE's space.
    expect(
      codeOf(() =>
        assertBdeMayWriteAudience('association', spaces, current, [
          { formation: 'ICM', campus: 'saint-etienne' },
          { formation: 'ISMIN', campus: 'saint-etienne' },
        ])
      )
    ).toBe('AUDIENCE_OUTSIDE_BDE_CAMPUS');
  });

  describe('an institution has no governing BDE (owner, 2026-11-02)', () => {
    /**
     * The real route guard over a service whose membership reads are this PostgreSQL: the officer is
     * a member of neither entity, so only the BDE tier could admit it.
     */
    const guardFor = () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const memberRepo = {
        query: (sql: string, params: unknown[]) => client.query(sql, params).then((r) => r.rows),
        findOne: ({ where }: { where: { associationId: string; userId: string } }) =>
          client
            .query(
              `SELECT * FROM association_members WHERE "associationId" = $1 AND "userId" = $2`,
              [where.associationId, where.userId]
            )
            .then((r) => r.rows[0] ?? null),
      };
      const unused = undefined as never;
      const service = new AssociationsService(
        unused, // assoRepo
        memberRepo as never, // memberRepo
        unused, // calendarRepo
        unused, // coOwnerRepo
        unused, // docRepo
        unused, // reviewerGrantRepo
        unused, // postRepo
        unused, // formRepo
        unused, // productRepo
        unused, // redis
        unused, // httpService
        unused, // notifications
        unused, // userTagService
        { enabled: () => false, tell: async () => 0 } as never // lydiaNotifier
      );
      // `PATCH :id { archived }` declares MANAGE_MEMBERS: the archive path.
      const reflector = { get: () => MANAGE_MEMBERS } as unknown as Reflector;
      return { guard: new GlobalAdminOrAssociationRoleGuard(reflector, service), service };
    };
    const archiveAs = (userId: string, id: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-user-id': userId }, params: { id } }),
        }),
        getHandler: () => undefined,
      }) as unknown as ExecutionContext;

    it('refuses the ICM BDE archiving an institution its space reaches', async () => {
      const { guard, service } = guardFor();
      expect(await service.isAssociationSuperAdminOf('icmOfficer', A.school)).toBe(false);
      await expect(guard.canActivate(archiveAs('icmOfficer', A.school))).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it('still admits the same BDE on an association of its space', async () => {
      const { guard } = guardFor();
      await expect(guard.canActivate(archiveAs('icmOfficer', A.clubIcm))).resolves.toBe(true);
    });

    /**
     * "Aucun BDE n'a les droits de gestion sur une institution, mais c'est le BDE qui a tous les
     * droits sur l'agenda des formations dont il est le BDE" (owner, 2026-11-03): the agenda follows
     * the spaces an event targets, the management of the institution reaches no BDE.
     */
    it("lets a BDE validate an institution's event targeting its spaces, and still manage nothing of it", async () => {
      const { guard, service } = guardFor();
      expect(await service.mayValidateEventsOf('icmOfficer', A.school)).toBe(true);
      expect(await service.associationsUnderBdeAgendaRight('icmOfficer')).toContain(A.school);
      // The members and profile routes (`MANAGE_MEMBERS`, `PATCH :id`) stay shut to the same officer.
      expect(await service.isAssociationSuperAdminOf('icmOfficer', A.school)).toBe(false);
      expect(await service.mayAct('icmOfficer', A.school, MANAGE_MEMBERS)).toBe(false);
      await expect(guard.canActivate(archiveAs('icmOfficer', A.school))).rejects.toBeInstanceOf(
        ForbiddenException
      );
    });

    it("refuses a BDE an institution's event targeting only another BDE's spaces", async () => {
      const { service } = guardFor();
      expect(await service.mayValidateEventsOf('icmOfficer', A.schoolIsmin)).toBe(false);
      expect(await service.associationsUnderBdeAgendaRight('icmOfficer')).not.toContain(
        A.schoolIsmin
      );
      // The BDE of the spaces it DOES target validates it.
      expect(await service.mayValidateEventsOf('isminOfficer', A.schoolIsmin)).toBe(true);
    });
  });
});
